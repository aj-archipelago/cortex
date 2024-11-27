import OpenAIVisionPlugin from "./openAiVisionPlugin.js";
import logger from "../../lib/logger.js";
import axios from 'axios';

const allowedMIMETypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

async function convertContentItem(item, maxImageSize) {
  let imageUrl = "";

  try {
    switch (typeof item) {
      case "string":
        return item ? { type: "text", text: item } : null;

      case "object":
        switch (item.type) {
          case "text":
            return item.text ? { type: "text", text: item.text } : null;

          case "image_url":
            imageUrl = item.url || item.image_url?.url || item.image_url;

            if (!imageUrl) {
              logger.warn("Could not parse image URL from content - skipping image content.");
              return null;
            }

            try {
              const urlData = imageUrl.startsWith("data:") ? imageUrl : await fetchImageAsDataURL(imageUrl);
              if (!urlData) { return null; }
              
              // Check base64 size
              const base64Size = (urlData.length * 3) / 4;
              if (base64Size > maxImageSize) {
                logger.warn(`Image size ${base64Size} bytes exceeds maximum allowed size ${maxImageSize} - skipping image content.`);
                return null;
              }
              
              const [, mimeType = "image/jpeg"] = urlData.match(/data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+).*,.*/) || [];
              const base64Image = urlData.split(",")[1];

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
    // First check headers
    const headResponse = await axios.head(imageUrl, {
      timeout: 30000, // 30 second timeout
      maxRedirects: 5
    });

    const contentType = headResponse.headers['content-type'];
    if (!contentType || !allowedMIMETypes.includes(contentType)) {
      logger.warn(`Unsupported image type: ${contentType} - skipping image content.`);
      return null;
    }

    // Then get the actual image data
    const dataResponse = await axios.get(imageUrl, {
      timeout: 30000,
      responseType: 'arraybuffer',
      maxRedirects: 5
    });

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
  
    // Extract system messages
    const systemMessages = messagesCopy.filter(message => message.role === "system");
    if (systemMessages.length > 0) {
      system = systemMessages.map(message => message.content).join("\n");
    }
  
    // Filter out system messages and empty messages
    let modifiedMessages = messagesCopy
      .filter(message => message.role !== "system" && message.content)
      .map(message => ({ ...message }));
  
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
        const claude3Content = await Promise.all(contentArray.map(item => convertContentItem(item, this.getModelMaxImageSize())));
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
      ? ":streamRawPredict"
      : ":rawPredict";

    const gcpAuthTokenHelper = this.config.get("gcpAuthTokenHelper");
    const authToken = await gcpAuthTokenHelper.getAccessToken();
    cortexRequest.auth.Authorization = `Bearer ${authToken}`;

    return this.executeRequest(cortexRequest);
  }

  processStreamEvent(event, requestProgress) {
    const eventData = JSON.parse(event.data);
    switch (eventData.type) {
      case "message_start":
        requestProgress.data = JSON.stringify(eventData.message);
        break;
      case "content_block_start":
        break;
      case "ping":
        break;
      case "content_block_delta":
        if (eventData.delta.type === "text_delta") {
          requestProgress.data = JSON.stringify(eventData.delta.text);
        }
        break;
      case "content_block_stop":
        break;
      case "message_delta":
        break;
      case "message_stop":
        requestProgress.data = "[DONE]";
        requestProgress.progress = 1;
        break;
      case "error":
        requestProgress.data = `\n\n*** ${
          eventData.error.message || eventData.error
        } ***`;
        requestProgress.progress = 1;
        break;
    }

    return requestProgress;
  }

  shortenContent(content, maxWords = 40) {
    const words = content.split(" ");
    if (words.length <= maxWords || logger.level === 'debug') {
      return content;
    }
    return words.slice(0, maxWords / 2).join(" ") +
      " ... " +
      words.slice(-maxWords / 2).join(" ");
  }
}

export default Claude3VertexPlugin;
