// OpenAICompletionPlugin.js
import ModelPlugin from './modelPlugin.js';

import { encode } from 'gpt-3-encoder';

class OpenAICompletionPlugin extends ModelPlugin {
    constructor(config, pathway) {
        super(config, pathway);
    }

    // Set up parameters specific to the OpenAI Completion API
    getRequestParameters(text, parameters, prompt) {
        let { modelPromptMessages, modelPromptText, tokenLength } = this.getCompiledPrompt(text, parameters, prompt);
        const { stream } = parameters;
        let modelPromptMessagesML = '';
        // Define the model's max token length
        const modelTargetTokenLength = this.getModelMaxTokenLength() * this.getPromptTokenRatio();
        let requestParameters = {};
    
        if (modelPromptMessages) {
            const minMsg = [{ role: "system", content: "" }];
            const addAssistantTokens = encode(this.messagesToChatML(minMsg, true).replace(this.messagesToChatML(minMsg, false), '')).length;
            const requestMessages = this.truncateMessagesToTargetLength(modelPromptMessages, (modelTargetTokenLength - addAssistantTokens));
            modelPromptMessagesML = this.messagesToChatML(requestMessages);
            tokenLength = encode(modelPromptMessagesML).length;
        
            if (tokenLength > modelTargetTokenLength) {
                throw new Error(`Input is too long at ${tokenLength} tokens (this target token length for this pathway is ${modelTargetTokenLength} tokens because the response is expected to take up the rest of the model's max tokens (${this.getModelMaxTokenLength()}). You must reduce the size of the prompt to continue.`);
            }
        
            const max_tokens = this.getModelMaxTokenLength() - tokenLength;
        
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
            if (tokenLength > modelTargetTokenLength) {
                throw new Error(`Input is too long at ${tokenLength} tokens. The target token length for this pathway is ${modelTargetTokenLength} tokens because the response is expected to take up the rest of the ${this.getModelMaxTokenLength()} tokens that the model can handle. You must reduce the size of the prompt to continue.`);
            }
        
            const max_tokens = this.getModelMaxTokenLength() - tokenLength;
        
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

export default OpenAICompletionPlugin;

