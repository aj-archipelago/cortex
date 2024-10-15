import OpenAIChatPlugin from './openAiChatPlugin.js';

function safeJsonParse(content) {
    try {
        const parsedContent = JSON.parse(content);
        return (typeof parsedContent === 'object' && parsedContent !== null) ? parsedContent : content;
    } catch (e) {
        return content;
    }
}

class OpenAIVisionPlugin extends OpenAIChatPlugin {
    
    tryParseMessages(messages) {
        return messages.map(message => {
            try {
                if (typeof message.content === 'string') {
                    message.content = safeJsonParse(message.content);
                }
                if (Array.isArray(message.content)) {
                    message.content = message.content.map(item => {
                        if (typeof item === 'string') {
                            const parsedItem = safeJsonParse(item);
                            if (parsedItem.type && (parsedItem.text || parsedItem.image_url)) {
                                return parsedItem;
                            } else {
                                return { type: 'text', text: item };
                            }
                        } else if (typeof item === 'object') {
                            const { type, text, image_url, url } = item;
                            return { type, text, image_url: url || image_url };
                        }
                        return item;
                    });
                }
            } catch (e) {
                return message;
            }
            return message;
        });
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
