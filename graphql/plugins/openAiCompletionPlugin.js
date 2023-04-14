// OpenAICompletionPlugin.js

import ModelPlugin from './modelPlugin.js';

import { encode } from 'gpt-3-encoder';

// Helper function to truncate the prompt if it is too long
const truncatePromptIfNecessary = (text, textTokenCount, modelMaxTokenCount, targetTextTokenCount, pathwayResolver) => {
    const maxAllowedTextTokenCount = textTokenCount + ((modelMaxTokenCount - targetTextTokenCount) * 0.5);

    if (textTokenCount > maxAllowedTextTokenCount) {
        pathwayResolver.logWarning(`Prompt is too long at ${textTokenCount} tokens (this target token length for this pathway is ${targetTextTokenCount} tokens because the response is expected to take up the rest of the model's max tokens (${modelMaxTokenCount}). Prompt will be truncated.`);
        return pathwayResolver.truncate(text, maxAllowedTextTokenCount);
    }
    return text;
}

class OpenAICompletionPlugin extends ModelPlugin {
    constructor(config, pathway) {
        super(config, pathway);
    }

    // Set up parameters specific to the OpenAI Completion API
    getRequestParameters(text, parameters, prompt, pathwayResolver) {
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

            modelPromptMessagesML = truncatePromptIfNecessary(modelPromptMessagesML, tokenLength, this.getModelMaxTokenLength(), modelTargetTokenLength, pathwayResolver);

            const max_tokens = this.getModelMaxTokenLength() - tokenLength;
            
            if (max_tokens < 0) {
                throw new Error(`Prompt is too long to successfully call the model at ${tokenLength} tokens.  The model will not be called.`);
            }
        
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

            modelPromptText = truncatePromptIfNecessary(modelPromptText, tokenLength, this.getModelMaxTokenLength(), modelTargetTokenLength, pathwayResolver);

            const max_tokens = this.getModelMaxTokenLength() - tokenLength;
            
            if (max_tokens < 0) {
                throw new Error(`Prompt is too long to successfully call the model at ${tokenLength} tokens.  The model will not be called.`);
            }
        
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
    async execute(text, parameters, prompt, pathwayResolver) {
        const url = this.requestUrl(text);
        const requestParameters = this.getRequestParameters(text, parameters, prompt, pathwayResolver);
    
        const data = { ...(this.model.params || {}), ...requestParameters };
        const params = {};
        const headers = this.model.headers || {};
        return this.executeRequest(url, data, params, headers, prompt);
    }
}

export default OpenAICompletionPlugin;

