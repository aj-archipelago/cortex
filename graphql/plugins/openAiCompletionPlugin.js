// OpenAICompletionPlugin.js
const ModelPlugin = require('./modelPlugin');
const { encode } = require("gpt-3-encoder");

class OpenAICompletionPlugin extends ModelPlugin {
    constructor(config, pathway) {
        super(config, pathway);
    }

    // Set up parameters specific to the OpenAI Completion API
    getRequestParameters(text, parameters, prompt) {
        let { modelPromptMessages, modelPromptText, tokenLength } = this.getCompiledPrompt(text, parameters, prompt);
        const { stream } = parameters;
        let modelPromptMessagesML = '';
        const modelMaxTokenLength = this.getModelMaxTokenLength();
        let requestParameters = {};
    
        if (modelPromptMessages) {
            const requestMessages = this.removeMessagesUntilTarget(modelPromptMessages, modelMaxTokenLength - 1);
            modelPromptMessagesML = this.messagesToChatML(requestMessages);
            tokenLength = encode(modelPromptMessagesML).length;
        
            if (tokenLength >= modelMaxTokenLength) {
                throw new Error(`The maximum number of tokens for this model is ${modelMaxTokenLength}. Please reduce the number of messages in the prompt.`);
            }
        
            const max_tokens = modelMaxTokenLength - tokenLength - 1;
        
            requestParameters = {
                prompt: modelPromptMessagesML,
                max_tokens: max_tokens,
                temperature: this.temperature ?? 0.7,
                top_p: 0.95,
                frequency_penalty: 0,
                presence_penalty: 0,
                stop: ["<|im_end|>"],
                stream
            };
        } else {
            if (tokenLength >= modelMaxTokenLength) {
                throw new Error(`The maximum number of tokens for this model is ${modelMaxTokenLength}. Please reduce the length of the prompt.`);
            }
        
            const max_tokens = modelMaxTokenLength - tokenLength - 1;
        
            requestParameters = {
                prompt: modelPromptText,
                max_tokens: max_tokens,
                temperature: this.temperature ?? 0.7,
                stream
            };
        }
    
        return requestParameters;
    }

    // Execute the request to the OpenAI Completion API
    async execute(text, parameters, prompt) {
        const url = this.requestUrl(text);
        const requestParameters = this.getRequestParameters(text, parameters, prompt);
    
        const data = { ...(this.model.params || {}), ...requestParameters };
        const params = {};
        const headers = this.model.headers || {};
        return this.executeRequest(url, data, params, headers, prompt);
    }
}

module.exports = OpenAICompletionPlugin;

