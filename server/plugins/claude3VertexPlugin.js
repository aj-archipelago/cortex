import OpenAIVisionPlugin from "./openAiVisionPlugin.js";
import logger from "../../lib/logger.js";
import mime from 'mime-types';

async function convertContentItem(item) {

  let imageUrl = "";
  let isDataURL = false;
  let urlData = "";
  let mimeTypeMatch = "";
  let mimeType = "";
  let base64Image = "";
  const allowedMIMETypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

  try {
    switch (typeof item) {
      case "string":
        return item ? { type: "text", text: item } : null;

      case "object":
        switch (item.type) {
          case "text":
            return item.text ? { type: "text", text: item.text } : null;

          case "image_url":
            imageUrl = item.image_url.url || item.image_url;
            if (!imageUrl) {
              logger.warn("Could not parse image URL from content - skipping image content.");
              return null;
            }

            if (!allowedMIMETypes.includes(mime.lookup(imageUrl) || "")) {
                logger.warn("Unsupported image type - skipping image content.");
                return null;
            }

            isDataURL = imageUrl.startsWith("data:");
            urlData = isDataURL ? item.image_url.url : await fetchImageAsDataURL(imageUrl);
            mimeTypeMatch = urlData.match(/data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+).*,.*/);
            mimeType = mimeTypeMatch && mimeTypeMatch[1] ? mimeTypeMatch[1] : "image/jpeg";
            base64Image = urlData.split(",")[1];

            return {
              type: "image",
              source: {
                type: "base64",
                media_type: mimeType,
                data: base64Image,
              },
            };

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
    const response = await fetch(imageUrl);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const buffer = await response.arrayBuffer();
    const base64Image = Buffer.from(buffer).toString("base64");
    const mimeType = mime.lookup(imageUrl) || "image/jpeg";
    return `data:${mimeType};base64,${base64Image}`;
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
    let modifiedMessages = [];
    let system = "";
    let lastAuthor = "";

    // Claude needs system messages in a separate field
    const systemMessages = messages.filter(
      (message) => message.role === "system"
    );
    if (systemMessages.length > 0) {
      system = systemMessages.map((message) => message.content).join("\n");
      modifiedMessages = messages.filter(
        (message) => message.role !== "system"
      );
    } else {
      modifiedMessages = messages;
    }

    // remove any empty messages
    modifiedMessages = modifiedMessages.filter((message) => message.content);

    // combine any consecutive messages from the same author
    var combinedMessages = [];

    modifiedMessages.forEach((message) => {
      if (message.role === lastAuthor) {
        combinedMessages[combinedMessages.length - 1].content +=
          "\n" + message.content;
      } else {
        combinedMessages.push(message);
        lastAuthor = message.role;
      }
    });

    modifiedMessages = combinedMessages;

    // Claude vertex requires an odd number of messages
    // for proper conversation turn-taking
    if (modifiedMessages.length % 2 === 0) {
      modifiedMessages = modifiedMessages.slice(1);
    }

    const claude3Messages = await Promise.all(
      modifiedMessages.map(async (message) => {
        const contentArray = Array.isArray(message.content) ? message.content : [message.content];
        const claude3Content = await Promise.all(contentArray.map(convertContentItem));
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
      logger.verbose(`${system}`);
    }

    if (messages && messages.length > 1) {
      logger.info(`[chat request sent containing ${messages.length} messages]`);
      let totalLength = 0;
      let totalUnits;
      messages.forEach((message, index) => {
        //message.content string or array
        const content = Array.isArray(message.content)
          ? message.content.map((item) => {
              if (item.source && item.source.type === 'base64') {
                item.source.data = '* base64 data truncated for log *';
              }
              return JSON.stringify(item);
            }).join(", ")
          : message.content;
        const words = content.split(" ");
        const { length, units } = this.getLength(content);
        const preview =
          words.length < 41
            ? content
            : words.slice(0, 20).join(" ") +
              " ... " +
              words.slice(-20).join(" ");

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
      logger.verbose(`${content}`);
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
}

export default Claude3VertexPlugin;
