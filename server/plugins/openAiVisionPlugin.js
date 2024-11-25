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
