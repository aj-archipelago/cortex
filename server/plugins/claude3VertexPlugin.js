import OpenAIVisionPlugin from "./openAiVisionPlugin.js";
import logger from "../../lib/logger.js";
import axios from 'axios';

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
  
  parseResponse(data) {
    if (!data) {
      return data;
    }

    const { content } = data;

    // if the response is an array, return the text property of the first item
    // if the type property is 'text'
    if (content && Array.isArray(content) && content[0].type === "text") {
      return content[0].text;
    } else {
      return data;
    }
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
  
  async getRequestParameters(text, parameters, prompt, cortexRequest) {
    const requestParameters = await super.getRequestParameters(
      text,
      parameters,
      prompt,
      cortexRequest
    );

    const { system, modifiedMessages } =
      await this.convertMessagesToClaudeVertex(requestParameters.messages);
    requestParameters.system = system;
    requestParameters.messages = modifiedMessages;

    // Convert OpenAI tools format to Claude format if present
    if (parameters.tools) {
      requestParameters.tools = parameters.tools.map(tool => {
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

    // If there are function calls in messages, generate tools block
    if (modifiedMessages?.some(msg => 
      Array.isArray(msg.content) && msg.content.some(item => item.type === 'tool_use')
    )) {
      const toolsMap = new Map();
      
      // Collect all unique tool uses from messages
      modifiedMessages.forEach(msg => {
        if (Array.isArray(msg.content)) {
          msg.content.forEach(item => {
            if (item.type === 'tool_use') {
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
      
      if (requestParameters.tools) {
        requestParameters.tools.push(...Array.from(toolsMap.values()));
      } else {
        requestParameters.tools = Array.from(toolsMap.values());
      }
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
        const content = Array.isArray(message.content)
          ? message.content.map((item) => {
              if (item.source && item.source.type === 'base64') {
                item.source.data = '* base64 data truncated for log *';
              }
              return JSON.stringify(item);
            }).join(", ")
          : message.content;
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
      const content = Array.isArray(message.content)
        ? message.content.map((item) => JSON.stringify(item)).join(", ")
        : message.content;
      const { length, units } = this.getLength(content);
      logger.info(`[request sent containing ${length} ${units}]`);
      logger.verbose(`${this.shortenContent(content)}`);
    }

    if (stream) {
      logger.info(`[response received as an SSE stream]`);
    } else {
      const responseText = this.parseResponse(responseData);
      const { length, units } = this.getLength(responseText);
      logger.info(`[response received containing ${length} ${units}]`);
      logger.verbose(`${responseText}`);
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

  processStreamEvent(event, requestProgress) {
    const eventData = JSON.parse(event.data);
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

    switch (eventData.type) {
      case "message_start":
        // Initial message with role
        baseOpenAIResponse.choices[0].delta = {
          role: "assistant",
          content: ""
        };
        requestProgress.data = JSON.stringify(baseOpenAIResponse);
        break;

      case "content_block_delta":
        if (eventData.delta.type === "text_delta") {
          baseOpenAIResponse.choices[0].delta = {
            content: eventData.delta.text
          };
          requestProgress.data = JSON.stringify(baseOpenAIResponse);
        }
        break;

      case "message_stop":
        baseOpenAIResponse.choices[0].delta = {};
        baseOpenAIResponse.choices[0].finish_reason = "stop";
        requestProgress.data = JSON.stringify(baseOpenAIResponse);
        requestProgress.progress = 1;
        break;

      case "error":
        baseOpenAIResponse.choices[0].delta = {
          content: `\n\n*** ${eventData.error.message || eventData.error} ***`
        };
        baseOpenAIResponse.choices[0].finish_reason = "error";
        requestProgress.data = JSON.stringify(baseOpenAIResponse);
        requestProgress.progress = 1;
        break;

      // Ignore other event types as they don't map to OpenAI format
      case "content_block_start":
      case "content_block_stop":
      case "message_delta":
      case "ping":
        break;
    }

    return requestProgress;
  }

}

export default Claude3VertexPlugin;
