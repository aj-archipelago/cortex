// palmChatPlugin.js
import ModelPlugin from './modelPlugin.js';
import { encode } from 'gpt-3-encoder';
import HandleBars from '../../lib/handleBars.js';

class PalmChatPlugin extends ModelPlugin {
    constructor(config, pathway, modelName, model) {
        super(config, pathway, modelName, model);
    }

    // Convert to PaLM messages array format if necessary
    convertMessagesToPalm(messages) {
        let context = '';
        let modifiedMessages = [];
        let lastAuthor = '';
    
        messages.forEach(message => {
            const { role, author, content } = message;
    
            // Extract system messages into the context string
            if (role === 'system') {
                context += (context.length > 0 ? '\n' : '') + content;
                return;
            }
     
            // Aggregate consecutive author messages, appending the content
            if ((role === lastAuthor || author === lastAuthor) && modifiedMessages.length > 0) {
                modifiedMessages[modifiedMessages.length - 1].content += '\n' + content;
            }
            // Only push messages with role 'user' or 'assistant' or existing author messages
            else if (role === 'user' || role === 'assistant' || author) {
                modifiedMessages.push({
                    author: author || role,
                    content,
                });
                lastAuthor = author || role;
            }
        });
    
        return {
            modifiedMessages,
            context,
        };
    }

    // Handlebars compiler for context (PaLM chat specific)
    getCompiledContext(text, parameters, context) {
        const combinedParameters = { ...this.promptParameters, ...parameters };
        return context ? HandleBars.compile(context)({ ...combinedParameters, text}) : '';
    }

    // Handlebars compiler for examples (PaLM chat specific)
    getCompiledExamples(text, parameters, examples = []) {
        const combinedParameters = { ...this.promptParameters, ...parameters };

        const compileContent = (content) => {
            const compile = HandleBars.compile(content);
            return compile({ ...combinedParameters, text });
        };

        const processExample = (example, key) => {
            if (example[key]?.content) {
                return { ...example[key], content: compileContent(example[key].content) };
            }
            return { ...example[key] };
        };

        return examples.map((example) => ({
            input: example.input ? processExample(example, 'input') : undefined,
            output: example.output ? processExample(example, 'output') : undefined,
        }));
    }

    // Set up parameters specific to the PaLM Chat API
    getRequestParameters(text, parameters, prompt) {
        const { modelPromptText, modelPromptMessages, tokenLength } = this.getCompiledPrompt(text, parameters, prompt);
        const { stream } = parameters;
    
        // Define the model's max token length
        const modelTargetTokenLength = this.getModelMaxTokenLength() * this.getPromptTokenRatio();
    
        const palmMessages = this.convertMessagesToPalm(modelPromptMessages || [{ "author": "user", "content": modelPromptText }]);
        
        let requestMessages = palmMessages.modifiedMessages;

        // Check if the token length exceeds the model's max token length
        if (tokenLength > modelTargetTokenLength) {
            // Remove older messages until the token length is within the model's limit
            requestMessages = this.truncateMessagesToTargetLength(requestMessages, modelTargetTokenLength);
        }

        const context = this.getCompiledContext(text, parameters, prompt.context || palmMessages.context || '');
        const examples = this.getCompiledExamples(text, parameters, prompt.examples || []);
        
        const max_tokens = this.getModelMaxReturnTokens();
        
        if (max_tokens < 0) {
            throw new Error(`Prompt is too long to successfully call the model at ${tokenLength} tokens.  The model will not be called.`);
        }
    
        // Ensure there are an even number of messages (PaLM requires an even number of messages)
        if (requestMessages.length % 2 === 0) {
            requestMessages = requestMessages.slice(1);
        }

        const requestParameters = {
            instances: [{
                context: context,
                examples: examples,
                messages: requestMessages,
            }],
            parameters: {
                temperature: this.temperature ?? 0.7,
                maxOutputTokens: max_tokens,
                topP: parameters.topP ?? 0.95,
                topK: parameters.topK ?? 40,
            }
        };
    
        return requestParameters;
    }

    // Get the safetyAttributes from the PaLM Chat API response data
    getSafetyAttributes(data) {
        const { predictions } = data;
        if (!predictions || !predictions.length) {
            return null;
        }

        // if we got a predictions array back with more than one prediction, return the safetyAttributes of the first prediction
        if (predictions.length > 1) {
            return predictions[0].safetyAttributes ?? null;
        }

        // otherwise, return the safetyAttributes of the content of the first prediction
        return predictions[0].safetyAttributes ?? null;
    }

    // Execute the request to the PaLM Chat API
    async execute(text, parameters, prompt, pathwayResolver) {
        const url = this.requestUrl(text);
        const requestParameters = this.getRequestParameters(text, parameters, prompt);
        const { requestId, pathway} = pathwayResolver;

        const data = { ...(this.model.params || {}), ...requestParameters };
        const params = {};
        const headers = this.model.headers || {};
        const gcpAuthTokenHelper = this.config.get('gcpAuthTokenHelper');
        const authToken = await gcpAuthTokenHelper.getAccessToken();
        headers.Authorization = `Bearer ${authToken}`;
        return this.executeRequest(url, data, params, headers, prompt, requestId, pathway);
    }

    // Parse the response from the PaLM Chat API
    parseResponse(data) {
        const { predictions } = data;
        if (!predictions || !predictions.length) {
            return null;
        }
    
        // Get the candidates array from the first prediction
        const { candidates } = predictions[0];

        // if it was blocked, return the blocked message
        if (predictions[0].safetyAttributes?.blocked) {
            return 'The response is blocked because the input or response potentially violates Google policies. Try rephrasing the prompt or adjusting the parameter settings. Currently, only English is supported.';
        }

        if (!candidates || !candidates.length) {
            return null;
        }
    
        // If we got a candidates array back with more than one candidate, return the whole array
        if (candidates.length > 1) {
            return candidates;
        }
    
        // Otherwise, return the content of the first candidate
        const messageResult = candidates[0].content && candidates[0].content.trim();
        return messageResult ?? null;
    }

    // Override the logging function to display the messages and responses
    logRequestData(data, responseData, prompt) {
        this.logAIRequestFinished();
    
        const instances = data && data.instances;
        const messages = instances && instances[0] && instances[0].messages;
        const { context, examples } = instances && instances [0] || {};
    
        if (context) {
            console.log(`\x1b[36mContext: ${context}\x1b[0m`);
        }

        if (examples && examples.length) {
            examples.forEach((example, index) => {
                console.log(`\x1b[36mExample ${index + 1}: Input: "${example.input.content}", Output: "${example.output.content}"\x1b[0m`);
            });
        }
        
        if (messages && messages.length > 1) {
            messages.forEach((message, index) => {
                const words = message.content.split(" ");
                const tokenCount = encode(message.content).length;
                const preview = words.length < 41 ? message.content : words.slice(0, 20).join(" ") + " ... " + words.slice(-20).join(" ");
    
                console.log(`\x1b[36mMessage ${index + 1}: Author: ${message.author}, Tokens: ${tokenCount}, Content: "${preview}"\x1b[0m`);
            });
        } else if (messages && messages.length === 1) {
            console.log(`\x1b[36m${messages[0].content}\x1b[0m`);
        }

        const safetyAttributes = this.getSafetyAttributes(responseData);

        console.log(`\x1b[34m> ${this.parseResponse(responseData)}\x1b[0m`);

        if (safetyAttributes) {
            console.log(`\x1b[33mSafety Attributes: ${JSON.stringify(safetyAttributes, null, 2)}\x1b[0m`);
        }
    
        if (prompt && prompt.debugInfo) {
            prompt.debugInfo += `\n${JSON.stringify(data)}`;
        }
    }
}

export default PalmChatPlugin;
