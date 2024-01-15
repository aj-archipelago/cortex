import OpenAIChatPlugin from './openAiChatPlugin.js';

class OpenAIVisionPlugin extends OpenAIChatPlugin {

    getRequestParameters(text, parameters, prompt) {
        const requestParameters = super.getRequestParameters(text, parameters, prompt);

        //check if elements of requestMessages strings are JSON, if valid JSON parse them to obj
        requestParameters.messages.map(message => {
            try {
                // message.content can be array or string
                if (typeof message.content === 'string') message.content = JSON.parse(message.content);
                else if (Array.isArray(message.content)) message.content = message.content.map(item => JSON.parse(item));
                
            } catch (e) {
                return message;
            }
        });

        if(this.promptParameters.max_tokens) {
            requestParameters.max_tokens = this.promptParameters.max_tokens;
        }

        return requestParameters;
    }

}

export default OpenAIVisionPlugin;
