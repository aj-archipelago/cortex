// palmChatPlugin.js
import ModelPlugin from './modelPlugin.js';
import HandleBars from '../../lib/handleBars.js';
import logger from '../../lib/logger.js';

class PalmChatPlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
    }

    // Convert to PaLM messages array format if necessary
    convertMessagesToPalm(messages) {
        let context = '';
        let modifiedMessages = [];
        let lastAuthor = '';
    
        // remove any empty messages
        messages = messages.filter(message => message.content);

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
    
        // Ensure there are an odd number of messages for turn taking
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
    async execute(text, parameters, prompt, cortexRequest) {
        const requestParameters = this.getRequestParameters(text, parameters, prompt);

        cortexRequest.data = { ...(cortexRequest.data || {}), ...requestParameters };
        cortexRequest.params = {}; // query params

        const gcpAuthTokenHelper = this.config.get('gcpAuthTokenHelper');
        const authToken = await gcpAuthTokenHelper.getAccessToken();
        cortexRequest.headers.Authorization = `Bearer ${authToken}`;

        return this.executeRequest(cortexRequest);
    }

    // Parse the response from the PaLM Chat API
    parseResponse(data) {
        const { predictions } = data;
        if (!predictions || !predictions.length) {
            return data;
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
        const instances = data && data.instances;
        const messages = instances && instances[0] && instances[0].messages;
        const { context, examples } = instances && instances [0] || {};
    
        if (context) {
            const { length, units } = this.getLength(context);
            logger.info(`[chat request contains context information of length ${length} ${units}]`)
            logger.debug(`context: ${context}`);
        }

        if (examples && examples.length) {
            logger.info(`[chat request contains ${examples.length} examples]`);
            examples.forEach((example, index) => {
                logger.debug(`example ${index + 1}: input: "${example.input.content}", output: "${example.output.content}"`);
            });
        }
        
        if (messages && messages.length > 1) {
            logger.info(`[chat request contains ${messages.length} messages]`);
            messages.forEach((message, index) => {
                const words = message.content.split(" ");
                const { length, units } = this.getLength(message.content);
                const preview = words.length < 41 ? message.content : words.slice(0, 20).join(" ") + " ... " + words.slice(-20).join(" ");
    
                logger.debug(`message ${index + 1}: author: ${message.author}, ${units}: ${length}, content: "${preview}"`);
            });
        } else if (messages && messages.length === 1) {
            logger.debug(`${messages[0].content}`);
        }

        const safetyAttributes = this.getSafetyAttributes(responseData);

        const responseText = this.parseResponse(responseData);
        const { length, units } = this.getLength(responseText);
        logger.info(`[response received containing ${length} ${units}]`);
        logger.debug(`${responseText}`);

        if (safetyAttributes) {
            logger.warn(`[response contains safety attributes: ${JSON.stringify(safetyAttributes, null, 2)}]`);
        }
    
        if (prompt && prompt.debugInfo) {
            prompt.debugInfo += `\n${JSON.stringify(data)}`;
        }
    }
}

export default PalmChatPlugin;
