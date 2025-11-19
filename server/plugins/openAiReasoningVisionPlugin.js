import OpenAIVisionPlugin from './openAiVisionPlugin.js';

class OpenAIReasoningVisionPlugin extends OpenAIVisionPlugin {
    
    async tryParseMessages(messages) {
        const parsedMessages = await super.tryParseMessages(messages);

        let newMessages = [];

        // System messages to developer: https://platform.openai.com/docs/guides/text-generation#messages-and-roles
        newMessages = parsedMessages.map(message => ({
            ...message,
            role: message.role === 'system' ? 'developer' : message.role
        })).filter(message => ['user', 'assistant', 'developer', 'tool'].includes(message.role));

        return newMessages;
    }

    async getRequestParameters(text, parameters, prompt) {
        const requestParameters = await super.getRequestParameters(text, parameters, prompt);

        const modelMaxReturnTokens = this.getModelMaxReturnTokens();
        const maxTokensPrompt = this.promptParameters.max_tokens;
        const maxTokensModel = this.getModelMaxTokenLength() * (1 - this.getPromptTokenRatio());

        const maxTokens = maxTokensPrompt || maxTokensModel;

        delete requestParameters.max_tokens;
        requestParameters.max_completion_tokens = maxTokens ? Math.min(maxTokens, modelMaxReturnTokens) : modelMaxReturnTokens;
        requestParameters.temperature = 1;

        const reasoningEffort = parameters.reasoningEffort || this.promptParameters.reasoningEffort;
        if (reasoningEffort) {
            const effort = reasoningEffort.toLowerCase();
            if (['high', 'medium', 'low'].includes(effort)) {
                requestParameters.reasoning_effort = effort;
            } else {
                requestParameters.reasoning_effort = 'low';
            }
        }
        
        if (this.promptParameters.responseFormat) {
            requestParameters.response_format = this.promptParameters.responseFormat;
        }

        return requestParameters;
    }
}

export default OpenAIReasoningVisionPlugin; 