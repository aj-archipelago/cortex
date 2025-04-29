// GroqChatPlugin.js
import ModelPlugin from './modelPlugin.js';
import logger from '../../lib/logger.js';

class GroqChatPlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
    }
    
    // Set up parameters specific to the Groq API
    getRequestParameters(text, parameters, prompt) {
        const combinedParameters = { ...this.promptParameters, ...parameters };
        const { modelPromptText, modelPromptMessages, tokenLength, modelPrompt } = this.getCompiledPrompt(text, parameters, prompt);
        
        // Use modelPromptMessages if available, otherwise fall back to other formats
        let messages = [];
        
        if (modelPromptMessages && Array.isArray(modelPromptMessages) && modelPromptMessages.length > 0) {
            // Use the messages directly from modelPromptMessages
            messages = modelPromptMessages;
        } else if (modelPrompt && modelPrompt.messages) {
            // If the prompt is already in a messages format, use it directly
            messages = modelPrompt.messages;
        } else if (typeof modelPromptText === 'string') {
            // If it's a string, convert to a user message
            messages = [
                { role: 'user', content: modelPromptText }
            ];
            
            // If a system message is provided in parameters, prepend it
            if (combinedParameters.systemMessage) {
                messages.unshift({
                    role: 'system',
                    content: combinedParameters.systemMessage
                });
            }
        }
        
        // Build request parameters for Groq API
        const requestParameters = {
            data: {
                model: this.model.params?.model || "meta-llama/llama-4-scout-17b-16e-instruct", // Default model if not specified
                messages: messages,
                temperature: combinedParameters.temperature !== undefined ? combinedParameters.temperature : 0.7,
                max_completion_tokens: combinedParameters.max_tokens || 4096,
                top_p: combinedParameters.top_p !== undefined ? combinedParameters.top_p : 1,
                stream: combinedParameters.stream === true
            }
        };
        
        // Add optional parameters if they exist
        if (combinedParameters.stop) {
            requestParameters.data.stop = combinedParameters.stop;
        }
        
        if (combinedParameters.presence_penalty !== undefined) {
            requestParameters.data.presence_penalty = combinedParameters.presence_penalty;
        }
        
        if (combinedParameters.frequency_penalty !== undefined) {
            requestParameters.data.frequency_penalty = combinedParameters.frequency_penalty;
        }
        
        return requestParameters;
    }

    // Execute the request to the Groq API
    async execute(text, parameters, prompt, cortexRequest) {
        const requestParameters = this.getRequestParameters(text, parameters, prompt);
        
        // Configure the request for Groq API
        cortexRequest.url = this.model.url;
        cortexRequest.method = 'POST';
        cortexRequest.data = requestParameters.data;
        cortexRequest.headers = this.model.headers;

        return this.executeRequest(cortexRequest);
    }
    
    // Parse the response from the Groq API
    parseResponse(data) {
        if (data && data.choices && data.choices.length > 0) {
            if (data.choices[0].message && data.choices[0].message.content) {
                return data.choices[0].message.content.trim();
            } else if (data.choices[0].text) {
                return data.choices[0].text.trim();
            }
        }
        return data;
    }
    
    // Override the logging function to display the request and response
    logRequestData(data, responseData, prompt) {
        // Find the user message
        const userMessage = data.messages.find(msg => msg.role === 'user');
        const modelInput = userMessage ? userMessage.content : JSON.stringify(data.messages);
        const modelOutput = this.parseResponse(responseData);
        
        logger.verbose(`Input: ${modelInput}`);
        logger.verbose(`Output: ${modelOutput}`);
        
        if (prompt?.debugInfo) {
            prompt.debugInfo += `\nInput: ${modelInput}\nOutput: ${modelOutput}`;
        }
    }
}

export default GroqChatPlugin;
