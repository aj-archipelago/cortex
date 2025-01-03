import OpenAIChatPlugin from './openAiChatPlugin.js';
import logger from '../../lib/logger.js';

function safeJsonParse(content) {
    try {
        const parsedContent = JSON.parse(content);
        return (typeof parsedContent === 'object' && parsedContent !== null) ? parsedContent : content;
    } catch (e) {
        return content;
    }
}

class OpenAIVisionPlugin extends OpenAIChatPlugin {

    constructor(pathway, model) {
        super(pathway, model);
        this.isMultiModal = true;
    }
    
    tryParseMessages(messages) {
        return messages.map(message => {
            try {
                if (message.role === "tool") {
                    return message;
                }
                if (Array.isArray(message.content)) {
                    message.content = message.content.map(item => {
                        const parsedItem = safeJsonParse(item);

                        if (typeof parsedItem === 'string') {
                            return { type: 'text', text: parsedItem };
                        }

                        if (typeof parsedItem === 'object' && parsedItem !== null && parsedItem.type === 'image_url') {
                            return {type: parsedItem.type, image_url: {url: parsedItem.url || parsedItem.image_url.url}};
                        }
                        
                        return parsedItem;
                    });
                }
            } catch (e) {
                return message;
            }
            return message;
        });
    }

    // Override the logging function to display the messages and responses
    logRequestData(data, responseData, prompt) {
        const { stream, messages } = data;
        if (messages && messages.length > 1) {
            logger.info(`[chat request sent containing ${messages.length} messages]`);
            let totalLength = 0;
            let totalUnits;
            messages.forEach((message, index) => {
                //message.content string or array
                const content = message.content === undefined ? JSON.stringify(message) : (Array.isArray(message.content) ? message.content.map(item => {
                    if (item.type === 'image_url' && item.image_url?.url?.startsWith('data:')) {
                        return JSON.stringify({
                            type: 'image_url',
                            image_url: { url: '* base64 data truncated for log *' }
                        });
                    }
                    return JSON.stringify(item);
                }).join(', ') : message.content);
                const { length, units } = this.getLength(content);
                const displayContent = this.shortenContent(content);

                logger.verbose(`message ${index + 1}: role: ${message.role}, ${units}: ${length}, content: "${displayContent}"`);
                totalLength += length;
                totalUnits = units;
            });
            logger.info(`[chat request contained ${totalLength} ${totalUnits}]`);
        } else {
            const message = messages[0];
            const content = Array.isArray(message.content) ? message.content.map(item => {
                if (item.type === 'image_url' && item.image_url?.url?.startsWith('data:')) {
                    return JSON.stringify({
                        type: 'image_url',
                        image_url: { url: '* base64 data truncated for log *' }
                    });
                }
                return JSON.stringify(item);
            }).join(', ') : message.content;
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
            logger.verbose(`${this.shortenContent(responseText)}`);
        }

        prompt && prompt.debugInfo && (prompt.debugInfo += `\n${JSON.stringify(data)}`);
    }


    getRequestParameters(text, parameters, prompt) {
        const requestParameters = super.getRequestParameters(text, parameters, prompt);

        this.tryParseMessages(requestParameters.messages);

        const modelMaxReturnTokens = this.getModelMaxReturnTokens();
        const maxTokensPrompt = this.promptParameters.max_tokens;
        const maxTokensModel = this.getModelMaxTokenLength() * (1 - this.getPromptTokenRatio());

        const maxTokens = maxTokensPrompt || maxTokensModel;

        requestParameters.max_tokens = maxTokens ? Math.min(maxTokens, modelMaxReturnTokens) : modelMaxReturnTokens;

        if (this.promptParameters.json) {
            //requestParameters.response_format = { type: "json_object", }
        }

        return requestParameters;
    }

}

export default OpenAIVisionPlugin;
