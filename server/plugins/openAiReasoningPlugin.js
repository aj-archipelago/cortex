import OpenAIChatPlugin from './openAiChatPlugin.js';

class OpenAIReasoningPlugin extends OpenAIChatPlugin {
    
    tryParseMessages(messages) {
        let newMessages = [];

        for (const message of messages) {
            if (message.role === 'user' || message.role === 'assistant') {
                newMessages.push({
                    ...message,
                    role: message.role,
                    content: this.parseContent(message.content)
                });
            } else if (message.role === 'system') {
                // System messages to developer: https://platform.openai.com/docs/guides/text-generation#messages-and-roles
                newMessages.push({
                    ...message,
                    role: "developer",
                    content: this.parseContent(message.content)
                });
            }
        }

        // Replace the contents of the original array with the new messages
        messages.splice(0, messages.length, ...newMessages);
    }

    parseContent(content) {
        if (typeof content === 'string') {
            return [{ type: 'text', text: content }];
        }
        if (Array.isArray(content)) {
            // Flatten content if it's a nested array
            const flatContent = content.flat();
            return flatContent.map(item => {
                if (typeof item === 'string') {
                    return { type: 'text', text: item };
                }
                if (typeof item === 'object' && item !== null) {
                    // If item already has type, return as-is
                    if (item.type) {
                        return { type: item.type, text: item.text || '' };
                    }
                    // Otherwise treat as text
                    return { type: 'text', text: JSON.stringify(item) };
                }
                return { type: 'text', text: String(item) };
            });
        }
        // Handle null, undefined, or empty content
        if (content === null || content === undefined || content === '') {
            return [{ type: 'text', text: '' }];
        }
        // Fallback for any other type
        return [{ type: 'text', text: String(content) }];
    }

    getRequestParameters(text, parameters, prompt) {
        const requestParameters = super.getRequestParameters(text, parameters, prompt);

        this.tryParseMessages(requestParameters.messages);

        const modelMaxReturnTokens = this.getModelMaxReturnTokens();
        const maxTokensPrompt = this.promptParameters.max_tokens;
        const maxTokensModel = this.getModelMaxTokenLength() * (1 - this.getPromptTokenRatio());

        const maxTokens = maxTokensPrompt || maxTokensModel;

        requestParameters.max_completion_tokens = maxTokens ? Math.min(maxTokens, modelMaxReturnTokens) : modelMaxReturnTokens;
        requestParameters.temperature = 1;

        if (this.promptParameters.reasoningEffort) {
            const effort = this.promptParameters.reasoningEffort.toLowerCase();
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

export default OpenAIReasoningPlugin;
