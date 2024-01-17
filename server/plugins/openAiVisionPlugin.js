import OpenAIChatPlugin from './openAiChatPlugin.js';


class OpenAIVisionPlugin extends OpenAIChatPlugin {

    tryParseMessages(messages) {
        //check if elements of messages strings are JSON, if valid JSON parse them to obj
        messages.map(message => {
            try {
                // message.content can be array or string
                if (typeof message.content === 'string') message.content = JSON.parse(message.content);
                else if (Array.isArray(message.content)) message.content = message.content.map(item => JSON.parse(item));
                
            } catch (e) {
                return message;
            }
        });
        return messages;
    }

    _truncateMessagesToTargetLength(messages, targetLength) {
        this.tryParseMessages(messages);

        const messagesList = [];
        for (const message of messages) {
            const { content } = message;
            if (typeof content === 'string') messagesList.push(content);
            else if (Array.isArray(content)) {
                for (const item of content) {
                    if (typeof item === 'string') messagesList.push(item);
                    else messagesList.push(item?.text || "");
                }
            }
        }

        const truncated = super.truncateMessagesToTargetLength(messagesList, targetLength);

        for (const message of messages) {
            const { content } = message;
            if (typeof content === 'string') {
                const truncatedText = truncated.shift();
                if(message.content != truncatedText){
                    console.log("truncatedText: ", truncatedText);
                    message.content = truncatedText;
                }
            }
            else if (Array.isArray(content)) {
                for (const item of content) {
                    const truncatedText = truncated.shift();
                    if(item.type=="text" && item.text != truncatedText){
                        console.log("truncatedText: ", truncatedText);
                        item.text = truncatedText;
                    }
                }
            }
        }

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
