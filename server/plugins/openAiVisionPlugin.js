import OpenAIChatPlugin from './openAiChatPlugin.js';


class OpenAIVisionPlugin extends OpenAIChatPlugin {

    tryParseMessages(messages) {
        //check if elements of messages strings are JSON, if valid JSON parse them to obj
        messages.map(message => {
            try {
                // message.content can be array or string
                if (typeof message.content === 'string') {
                    message.content = JSON.parse(message.content);
                } else if (Array.isArray(message.content)) {
                    message.content = message.content.map(item => {
                        const parsedItem = JSON.parse(item);
                        const { type, text, image_url, url } = parsedItem;
                        return { type, text, image_url: url || image_url};
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

        if(this.promptParameters.max_tokens) {
            requestParameters.max_tokens = this.promptParameters.max_tokens;
        }

        return requestParameters;
    }

}

export default OpenAIVisionPlugin;
