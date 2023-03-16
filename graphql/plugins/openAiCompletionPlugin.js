// OpenAICompletionPlugin.js
const ModelPlugin = require('./modelPlugin');
const handlebars = require("handlebars");
const { encode } = require("gpt-3-encoder");

//convert a messages array to a simple chatML format
const messagesToChatML = (messages) => {
    let output = "";
    if (messages && messages.length) {
        for (let message of messages) {
            output += (message.role && message.content) ? `<|im_start|>${message.role}\n${message.content}\n<|im_end|>\n` : `${message}\n`;
        }
        // you always want the assistant to respond next so add a
        // directive for that
        output += "<|im_start|>assistant\n";
    }
    return output;
}

class OpenAICompletionPlugin extends ModelPlugin {
    constructor(config, pathway) {
        super(config, pathway);
    }

    // Set up parameters specific to the OpenAI Completion API
    requestParameters(text, parameters, prompt) {
        const combinedParameters = { ...this.promptParameters, ...parameters };
        const modelPrompt = this.getModelPrompt(prompt, parameters);
        const modelPromptText = modelPrompt.prompt ? handlebars.compile(modelPrompt.prompt)({ ...combinedParameters, text }) : '';
        const modelPromptMessages = this.getModelPromptMessages(modelPrompt, combinedParameters, text);
        const modelPromptMessagesML = messagesToChatML(modelPromptMessages);

        if (modelPromptMessagesML) {
        return {
            prompt: modelPromptMessagesML,
            max_tokens: this.getModelMaxTokenLength() - encode(modelPromptMessagesML).length - 1,
            temperature: this.temperature ?? 0.7,
            top_p: 0.95,
            frequency_penalty: 0,
            presence_penalty: 0,
            stop: ["<|im_end|>"]
        };
        } else {
        return {
            prompt: modelPromptText,
            max_tokens: this.getModelMaxTokenLength() - encode(modelPromptText).length - 1,
            temperature: this.temperature ?? 0.7,
        };
        }
    }

    // Execute the request to the OpenAI Completion API
    async execute(text, parameters, prompt) {
        const url = this.requestUrl(text);
        const requestParameters = this.requestParameters(text, parameters, prompt);
    
        const data = { ...(this.model.params || {}), ...requestParameters };
        const params = {};
        const headers = this.model.headers || {};
        return this.executeRequest(url, data, params, headers);
    }
}

module.exports = OpenAICompletionPlugin;

