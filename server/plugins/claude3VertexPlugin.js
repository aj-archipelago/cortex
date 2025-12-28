import OpenAIVisionPlugin from "./openAiVisionPlugin.js";
import logger from "../../lib/logger.js";
import { requestState } from '../requestState.js';
import { addCitationsToResolver } from '../../lib/pathwayTools.js';
import CortexResponse from '../../lib/cortexResponse.js';
import axios from 'axios';
import { sanitizeBase64 } from "../../lib/util.js";

async function convertContentItem(item, maxImageSize, plugin) {
  let imageUrl = "";

  try {
    switch (typeof item) {
      case "string":
        return item ? { type: "text", text: item } : null;

      case "object":
        switch (item.type) {
          case "text":
            return item.text ? { type: "text", text: item.text } : null;

          case "tool_use":
            return {
              type: "tool_use",
              id: item.id,
              name: item.name,
              input: typeof item.input === 'string' ? { query: item.input } : item.input
            };

          case "tool_result":
            return {
              type: "tool_result",
              tool_use_id: item.tool_use_id,
              content: item.content
            };

          case "image_url":
            imageUrl = item.url || item.image_url?.url || item.image_url;

            if (!imageUrl) {
              logger.warn("Could not parse image URL from content - skipping image content.");
              return null;
            }

            try {
              // First validate the image URL
              if (!await plugin.validateImageUrl(imageUrl)) {
                return null;
              }

              // Then fetch and convert to base64 if needed
              const urlData = imageUrl.startsWith("data:") ? imageUrl : await fetchImageAsDataURL(imageUrl);
              if (!urlData) { return null; }
              
              const base64Image = urlData.split(",")[1];
              // Calculate actual decoded size of base64 data
              const base64Size = Buffer.from(base64Image, 'base64').length;
              
              if (base64Size > maxImageSize) {
                logger.warn(`Image size ${base64Size} bytes exceeds maximum allowed size ${maxImageSize} - skipping image content.`);
                return null;
              }
              
              const [, mimeType = "image/jpeg"] = urlData.match(/data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+).*,.*/) || [];

              return {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mimeType,
                  data: base64Image,
                },
              };
            } catch (error) {
              logger.error(`Failed to process image: ${error.message}`);
              return null;
            }

          default:
            return null;
        }

      default:
        return null;
    }
  }
  catch (e) {
    logger.warn(`Error converting content item: ${e}`);
    return null;
  }
}

// Fetch image and convert to base 64 data URL
async function fetchImageAsDataURL(imageUrl) {
  try {
    // Get the actual image data
    const dataResponse = await axios.get(imageUrl, {
      timeout: 30000,
      responseType: 'arraybuffer',
      maxRedirects: 5
    });

    const contentType = dataResponse.headers['content-type'];
    const base64Image = Buffer.from(dataResponse.data).toString('base64');
    return `data:${contentType};base64,${base64Image}`;
  }
  catch (e) {
    logger.error(`Failed to fetch image: ${imageUrl}. ${e}`);
    throw e;
  }
}

class Claude3VertexPlugin extends OpenAIVisionPlugin {
  
  constructor(pathway, model) {
    super(pathway, model);
    this.isMultiModal = true;
    this.pathwayToolCallback = pathway.toolCallback;
    this.toolCallsBuffer = [];
    this.contentBuffer = ''; // Initialize content buffer
    this.hadToolCalls = false; // Track if this stream had tool calls
  }
  
  // Override tryParseMessages to add Claude-specific content types (tool_use, tool_result)
  async tryParseMessages(messages) {
    // Whitelist of content types we accept from parsed JSON strings
    // Only these types will be used if a JSON string parses to an object
    // Includes Claude-specific types: tool_use, tool_result
    const WHITELISTED_CONTENT_TYPES = ['text', 'image', 'image_url', 'tool_use', 'tool_result'];
    
    // Helper to check if an object is a valid whitelisted content type
    const isValidContentObject = (obj) => {
      return (
        typeof obj === 'object' && 
        obj !== null && 
        typeof obj.type === 'string' &&
        WHITELISTED_CONTENT_TYPES.includes(obj.type)
      );
    };
    
    function safeJsonParse(content) {
      try {
        const parsedContent = JSON.parse(content);
        return (typeof parsedContent === 'object' && parsedContent !== null) ? parsedContent : content;
      } catch (e) {
        return content;
      }
    }
    
    return await Promise.all(messages.map(async message => {
      try {
        // Parse tool_calls from string array to object array if present
        const parsedMessage = { ...message };
        if (message.tool_calls && Array.isArray(message.tool_calls)) {
          parsedMessage.tool_calls = message.tool_calls.map(tc => {
            if (typeof tc === 'string') {
              try {
                return JSON.parse(tc);
              } catch (e) {
                logger.warn(`Failed to parse tool_call: ${tc}`);
                return tc;
              }
            }
            return tc;
          });
        }
        
        // Handle tool-related message types
        // For tool messages, OpenAI supports content as either:
        // 1. A string (text content)
        // 2. An array of text content parts: [{ type: "text", text: "..." }]
        if (message.role === "tool") {
          // If content is already a string, keep it as-is
          if (typeof parsedMessage.content === 'string') {
            return parsedMessage;
          }
          
          // If content is an array, process it
          if (Array.isArray(parsedMessage.content)) {
            // Check if array is already in the correct format (array of text content parts)
            const isTextContentPartsArray = parsedMessage.content.every(item => 
              typeof item === 'object' && 
              item !== null && 
              item.type === 'text' && 
              typeof item.text === 'string'
            );
            
            if (isTextContentPartsArray) {
              // Already in correct format, keep as array
              return parsedMessage;
            }
            
            // Convert array to array of text content parts
            parsedMessage.content = parsedMessage.content.map(item => {
              if (typeof item === 'string') {
                return { type: 'text', text: item };
              }
              if (typeof item === 'object' && item !== null && item.text) {
                return { type: 'text', text: String(item.text) };
              }
              return { type: 'text', text: JSON.stringify(item) };
            });
            return parsedMessage;
          }
          
          // If content is null/undefined, convert to empty string
          if (parsedMessage.content == null) {
            parsedMessage.content = '';
          }
          
          return parsedMessage;
        }
        
        // For assistant messages with tool_calls, return as-is (content can be null or string)
        if (message.role === "assistant" && parsedMessage.tool_calls) {
          return parsedMessage;
        }

        if (Array.isArray(message.content)) {
          return {
            ...parsedMessage,
            content: await Promise.all(message.content.map(async item => {
              // A content array item can be a plain string, a JSON string, or a valid content object
              let itemToProcess, contentType;

              // First try to parse it as a JSON string
              const parsedItem = safeJsonParse(item);
              
              // Check if parsed item is a known content object
              if (isValidContentObject(parsedItem)) {
                itemToProcess = parsedItem;
                contentType = parsedItem.type;
              } 
              // It's not, so check if original item is already a known content object
              else if (isValidContentObject(item)) {
                itemToProcess = item;
                contentType = item.type;
              } 
              // It's not, so return it as a text object. This covers all unknown objects and strings.
              else {
                const textContent = typeof item === 'string' ? item : JSON.stringify(item);
                return { type: 'text', text: textContent };
              }
              
              // Process whitelisted content types (we know contentType is known and valid at this point)
              if (contentType === 'text') {
                return { type: 'text', text: itemToProcess.text || '' };
              }
              
              if (contentType === 'image' || contentType === 'image_url') {
                const url = itemToProcess.url || itemToProcess.image_url?.url;
                if (url && await this.validateImageUrl(url)) {
                  return { type: 'image_url', image_url: { url } };
                }
              }

              // Handle Claude-specific content types
              if (contentType === 'tool_use' || contentType === 'tool_result') {
                return itemToProcess;
              }

              // If we got here, we failed to process something - likely the image - so we'll return it as a text object.
              const textContent = typeof itemToProcess === 'string' 
                ? itemToProcess 
                : JSON.stringify(itemToProcess);
              return { type: 'text', text: textContent };
            }))
          };
        }
      } catch (e) {
        return message;
      }
      return message;
    }));
  }
  
  parseResponse(data) {
    if (!data) {
      return data;
    }

    const { content, usage, stop_reason } = data;

    // Handle tool use responses from Claude
    if (content && Array.isArray(content)) {
      const toolUses = content.filter(item => item.type === "tool_use");
      if (toolUses.length > 0) {
        // Create standardized CortexResponse object for tool calls
        const cortexResponse = new CortexResponse({
          output_text: "",
          finishReason: "tool_calls",
          usage: usage || null,
          metadata: {
            model: this.modelName
          }
        });

        // Convert Claude tool uses to OpenAI format
        cortexResponse.toolCalls = toolUses.map(toolUse => ({
          id: toolUse.id,
          type: "function",
          function: {
            name: toolUse.name,
            arguments: JSON.stringify(toolUse.input)
          }
        }));

        return cortexResponse;
      }

      // Handle regular text responses
      const textContent = content.find(item => item.type === "text");
      if (textContent) {
        // Create standardized CortexResponse object for text responses
        const cortexResponse = new CortexResponse({
          output_text: textContent.text || "",
          finishReason: stop_reason === "tool_use" ? "tool_calls" : "stop",
          usage: usage || null,
          metadata: {
            model: this.modelName
          }
        });

        return cortexResponse;
      }
    }

    return data;
  }

  // This code converts messages to the format required by the Claude Vertex API
  async convertMessagesToClaudeVertex(messages) {
    // Create a deep copy of the input messages
    const messagesCopy = JSON.parse(JSON.stringify(messages));
  
    let system = "";
    let imageCount = 0;
    const maxImages = 20; // Claude allows up to 20 images per request
  
    // Extract system messages
    const systemMessages = messagesCopy.filter(message => message.role === "system");
    if (systemMessages.length > 0) {
      system = systemMessages.map(message => {
        if (Array.isArray(message.content)) {
          // For content arrays, extract text content and join
          return message.content
            .filter(item => item.type === 'text')
            .map(item => item.text)
            .join("\n");
        }
        return message.content;
      }).join("\n");
    }
  
    // Filter out system messages and empty messages
    let modifiedMessages = messagesCopy
      .filter(message => message.role !== "system")
      .map(message => {
        // Handle OpenAI tool calls format conversion to Claude format
        if (message.tool_calls) {
          return {
            role: message.role,
            content: message.tool_calls.map(toolCall => ({
              type: "tool_use",
              id: toolCall.id,
              name: toolCall.function.name,
              input: JSON.parse(toolCall.function.arguments)
            }))
          };
        }
        
        // Handle OpenAI tool response format conversion to Claude format
        if (message.role === "tool") {
          return {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: message.tool_call_id,
              content: message.content
            }]
          };
        }

        return { ...message };
      })
      .filter(message => {
        // Filter out messages with empty content
        if (!message.content) return false;
        if (Array.isArray(message.content) && message.content.length === 0) return false;
        return true;
      });

    // Combine consecutive messages from the same author
    const combinedMessages = modifiedMessages.reduce((acc, message) => {
      if (acc.length === 0 || message.role !== acc[acc.length - 1].role) {
        acc.push({ ...message });
      } else {
        const lastMessage = acc[acc.length - 1];
        if (Array.isArray(lastMessage.content) && Array.isArray(message.content)) {
          lastMessage.content = [...lastMessage.content, ...message.content];
        } else if (Array.isArray(lastMessage.content)) {
          lastMessage.content.push({ type: 'text', text: message.content });
        } else if (Array.isArray(message.content)) {
          lastMessage.content = [{ type: 'text', text: lastMessage.content }, ...message.content];
        } else {
          lastMessage.content += "\n" + message.content;
        }
      }
      return acc;
    }, []);
  
    // Ensure an odd number of messages
    const finalMessages = combinedMessages.length % 2 === 0
      ? combinedMessages.slice(1)
      : combinedMessages;
  
    // Convert content items
    const claude3Messages = await Promise.all(
      finalMessages.map(async (message) => {
        const contentArray = Array.isArray(message.content) ? message.content : [message.content];
        const claude3Content = await Promise.all(contentArray.map(async item => {
          const convertedItem = await convertContentItem(item, this.getModelMaxImageSize(), this);
          
          // Track image count
          if (convertedItem?.type === 'image') {
            imageCount++;
            if (imageCount > maxImages) {
              logger.warn(`Maximum number of images (${maxImages}) exceeded - skipping additional images.`);
              return null;
            }
          }
          
          return convertedItem;
        }));
        return {
          role: message.role,
          content: claude3Content.filter(Boolean),
        };
      })
    );
  
    return {
      system,
      modifiedMessages: claude3Messages,
    };
  }
  
  async getRequestParameters(text, parameters, prompt) {
    const requestParameters = await super.getRequestParameters(
      text,
      parameters,
      prompt
    );

    const { system, modifiedMessages } =
      await this.convertMessagesToClaudeVertex(requestParameters.messages);
    requestParameters.system = system;
    requestParameters.messages = modifiedMessages;

    // Convert OpenAI tools format to Claude format if present
    let toolsArray = parameters.tools;
    if (typeof toolsArray === 'string') {
      try {
        toolsArray = JSON.parse(toolsArray);
      } catch (e) {
        toolsArray = [];
      }
    }
    
    if (toolsArray && Array.isArray(toolsArray) && toolsArray.length > 0) {
      requestParameters.tools = toolsArray.map(tool => {
        if (tool.type === 'function') {
          return {
            name: tool.function.name,
            description: tool.function.description,
                  input_schema: {
              type: "object",
              properties: tool.function.parameters.properties,
              required: tool.function.parameters.required || []
            }
          };
        }
        return tool;
      });
    }

    // Handle tool_choice parameter conversion from OpenAI format to Claude format
    if (parameters.tool_choice) {
      let toolChoice = parameters.tool_choice;
      
      // Parse JSON string if needed
      if (typeof toolChoice === 'string') {
        try {
          toolChoice = JSON.parse(toolChoice);
        } catch (e) {
          // If not JSON, handle as simple string values: auto, required, none
          if (toolChoice === 'required') {
            requestParameters.tool_choice = { type: 'any' }; // OpenAI's 'required' maps to Claude's 'any'
          } else if (toolChoice === 'auto') {
            requestParameters.tool_choice = { type: 'auto' };
          } else if (toolChoice === 'none') {
            requestParameters.tool_choice = { type: 'none' };
          }
          toolChoice = null; // Prevent further processing
        }
      }
      
      // Handle parsed object
      if (toolChoice && toolChoice.type === "function") {
        // Handle function-specific tool choice
        requestParameters.tool_choice = {
          type: "tool",
          name: toolChoice.function.name || toolChoice.function
        };
      }
    }

    // If there are function calls in messages, generate tools block
    if (modifiedMessages?.some(msg => 
      Array.isArray(msg.content) && msg.content.some(item => item.type === 'tool_use')
    )) {
      const toolsMap = new Map();
      
      // First add any existing tools from parameters to the map
      if (requestParameters.tools) {
        requestParameters.tools.forEach(tool => {
          toolsMap.set(tool.name, tool);
        });
      }
      
      // Collect all unique tool uses from messages, only adding if not already present
      modifiedMessages.forEach(msg => {
        if (Array.isArray(msg.content)) {
          msg.content.forEach(item => {
            if (item.type === 'tool_use' && !toolsMap.has(item.name)) {
              toolsMap.set(item.name, {
                name: item.name,
                description: `Tool for ${item.name}`,
                input_schema: {
                  type: "object",
                  properties: item.input ? Object.keys(item.input).reduce((acc, key) => {
                    acc[key] = {
                      type: typeof item.input[key] === 'string' ? 'string' : 'object',
                      description: `Parameter ${key} for ${item.name}`
                    };
                    return acc;
                  }, {}) : {},
                  required: item.input ? Object.keys(item.input) : []
                }
              });
            }
          });
        }
      });
      
      // Update the tools array with the combined unique tools
      requestParameters.tools = Array.from(toolsMap.values());
    }

    requestParameters.max_tokens = this.getModelMaxReturnTokens();
    requestParameters.anthropic_version = "vertex-2023-10-16";
    return requestParameters;
  }

  // Override the logging function to display the messages and responses
  logRequestData(data, responseData, prompt) {
    const { stream, messages, system } = data;
    if (system) {
      const { length, units } = this.getLength(system);
      logger.info(`[system messages sent containing ${length} ${units}]`);
      logger.verbose(`${this.shortenContent(system)}`);
    }

    if (messages && messages.length > 1) {
      logger.info(`[chat request sent containing ${messages.length} messages]`);
      let totalLength = 0;
      let totalUnits;
      messages.forEach((message, index) => {
        let content;
        if (Array.isArray(message.content)) {
          // Only stringify objects, not strings (which may already be JSON strings)
          content = message.content.map((item) => {
            const sanitized = sanitizeBase64(item);
            return typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
          }).join(", ");
        } else {
          content = message.content;
        }
        const { length, units } = this.getLength(content);
        const preview = this.shortenContent(content);

        logger.verbose(
          `message ${index + 1}: role: ${
            message.role
          }, ${units}: ${length}, content: "${preview}"`
        );
        totalLength += length;
        totalUnits = units;
      });
      logger.info(`[chat request contained ${totalLength} ${totalUnits}]`);
    } else {
      const message = messages[0];
      let content;
      if (Array.isArray(message.content)) {
        // Only stringify objects, not strings (which may already be JSON strings)
        content = message.content.map((item) => {
          return typeof item === 'string' ? item : JSON.stringify(item);
        }).join(", ");
      } else {
        content = message.content;
      }
      const { length, units } = this.getLength(content);
      logger.info(`[request sent containing ${length} ${units}]`);
      logger.verbose(`${this.shortenContent(content)}`);
    }

    if (stream) {
      logger.info(`[response received as an SSE stream]`);
    } else {
      const parsedResponse = this.parseResponse(responseData);
      
      if (typeof parsedResponse === 'string') {
          const { length, units } = this.getLength(parsedResponse);
          logger.info(`[response received containing ${length} ${units}]`);
          logger.verbose(`${this.shortenContent(parsedResponse)}`);
      } else {
          logger.info(`[response received containing object]`);
          logger.verbose(`${JSON.stringify(parsedResponse)}`);
      }
  }

    prompt &&
      prompt.debugInfo &&
      (prompt.debugInfo += `\n${JSON.stringify(data)}`);
  }

  async execute(text, parameters, prompt, cortexRequest) {
    const requestParameters = await this.getRequestParameters(
      text,
      parameters,
      prompt,
      cortexRequest
    );
    const { stream } = parameters;

    cortexRequest.data = {
      ...(cortexRequest.data || {}),
      ...requestParameters,
    };
    cortexRequest.params = {}; // query params
    cortexRequest.stream = stream;
    cortexRequest.urlSuffix = cortexRequest.stream
      ? ":streamRawPredict?alt=sse"
      : ":rawPredict";

    const gcpAuthTokenHelper = this.config.get("gcpAuthTokenHelper");
    const authToken = await gcpAuthTokenHelper.getAccessToken();
    cortexRequest.auth.Authorization = `Bearer ${authToken}`;

    return this.executeRequest(cortexRequest);
  }

  convertClaudeSSEToOpenAI(event) {
    // Handle end of stream
    if (event.data.trim() === '[DONE]') {
      return event; // Pass through unchanged
    }

    let eventData;
    try {
      eventData = JSON.parse(event.data);
    } catch (error) {
      throw new Error(`Could not parse stream data: ${error}`);
    }

    const baseOpenAIResponse = {
      id: eventData.message?.id || `chatcmpl-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.modelName,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: null
      }]
    };

    let delta = {};
    let finishReason = null;

    // Handle errors - convert to OpenAI error format instead of throwing
    const streamError = eventData?.error?.message || eventData?.error;
    if (streamError) {
      delta = {
        content: `\n\n*** ${streamError} ***`
      };
      finishReason = "error";
      
      // Update the OpenAI response
      baseOpenAIResponse.choices[0].delta = delta;
      baseOpenAIResponse.choices[0].finish_reason = finishReason;
      
      // Create new event with OpenAI format
      return {
        ...event,
        data: JSON.stringify(baseOpenAIResponse)
      };
    }

    // Handle different Claude event types
    switch (eventData.type) {
      case "message_start":
        delta = { role: "assistant", content: "" };
        // Reset tool calls flag for new message
        this.hadToolCalls = false;
        break;

      case "content_block_delta":
        if (eventData.delta.type === "text_delta") {
          delta = { content: eventData.delta.text };
        } else if (eventData.delta.type === "input_json_delta") {
          // Handle tool call argument streaming
          const toolCallIndex = eventData.index || 0;
          
          // Create OpenAI tool call delta - parent class will handle accumulation
          delta = {
            tool_calls: [{
              index: toolCallIndex,
              id: eventData.id || `call_${toolCallIndex}_${Date.now()}`,
              type: "function",
              function: {
                arguments: eventData.delta.partial_json || ""
              }
            }]
          };
        } else if (eventData.delta.type === "name_delta") {
          // Handle tool call name streaming
          const toolCallIndex = eventData.index || 0;
          
          // Create OpenAI tool call delta - parent class will handle accumulation
          delta = {
            tool_calls: [{
              index: toolCallIndex,
              id: eventData.id || `call_${toolCallIndex}_${Date.now()}`,
              type: "function",
              function: {
                name: eventData.delta.name || ""
              }
            }]
          };
        }
        break;

      case "content_block_start":
        if (eventData.content_block.type === "tool_use") {
          // Mark that we have tool calls in this stream
          this.hadToolCalls = true;
          
          // Create OpenAI tool call delta - parent class will handle buffer management
          const toolCallIndex = eventData.index || 0;
          delta = {
            tool_calls: [{
              index: toolCallIndex,
              id: eventData.content_block.id || `call_${toolCallIndex}_${Date.now()}`,
              type: "function",
              function: {
                name: eventData.content_block.name || ""
              }
            }]
          };
        }
        break;

      case "message_delta":
        // Handle message delta events (like stop_reason)
        // Don't set finish_reason here - let the stream continue until message_stop
        delta = {};
        break;

      case "message_stop":
        delta = {};
        // Determine finish reason based on whether there were tool calls in this stream
        if (this.hadToolCalls) {
          finishReason = "tool_calls";
        } else {
          finishReason = "stop";
        }
        break;

      case "error":
        delta = {
          content: `\n\n*** ${eventData.error.message || eventData.error} ***`
        };
        finishReason = "error";
        break;

      // Ignore other event types as they don't map to OpenAI format
      case "content_block_stop":
      case "message_delta":
      case "ping":
        break;
    }

    // Update the OpenAI response
    baseOpenAIResponse.choices[0].delta = delta;
    if (finishReason) {
      baseOpenAIResponse.choices[0].finish_reason = finishReason;
    }

    // Create new event with OpenAI format
    return {
      ...event,
      data: JSON.stringify(baseOpenAIResponse)
    };
  }

  processStreamEvent(event, requestProgress) {
    // Convert Claude event to OpenAI format
    const openAIEvent = this.convertClaudeSSEToOpenAI(event);
    
    // Delegate to parent class for all the tool call logic
    return super.processStreamEvent(openAIEvent, requestProgress);
  }

}

export default Claude3VertexPlugin;
