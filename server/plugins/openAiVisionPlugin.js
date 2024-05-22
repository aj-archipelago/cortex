import OpenAIChatPlugin from './openAiChatPlugin.js';


class OpenAIVisionPlugin extends OpenAIChatPlugin {

    tryParseMessages(messages) {
        messages.map(message => {
            try {
                if (typeof message.content === 'string') {
                    message.content = JSON.parse(message.content);
                }
                if (Array.isArray(message.content)) {
                    message.content = message.content.map(item => {
                        if (typeof item === 'string') {
                            return { type: 'text', text: item };
                        } else {
                            const parsedItem = JSON.parse(item);
                            const { type, text, image_url, url } = parsedItem;
                            return { type, text, image_url: url || image_url };
                        }
                    });
                }     
            } catch (e) {
                return message;
            }
        });
        return messages;
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
