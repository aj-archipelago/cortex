// OpenAIChatPlugin.js
import ModelPlugin from './modelPlugin.js';
import logger from '../../lib/logger.js';
import CortexResponse from '../../lib/cortexResponse.js';

class OpenAIChatPlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
    }

    // convert to OpenAI messages array format if necessary
    convertPalmToOpenAIMessages(context, examples, messages) {
        let openAIMessages = [];
        
        // Add context as a system message
        if (context) {
            openAIMessages.push({
            role: 'system',
            content: context,
            });
        }
        
        // Add examples to the messages array
        examples.forEach(example => {
            openAIMessages.push({
            role: example.input.author || 'user',
            content: example.input.content,
            });
            openAIMessages.push({
            role: example.output.author || 'assistant',
            content: example.output.content,
            });
        });
        
        // Add remaining messages to the messages array
        messages.forEach(message => {
            openAIMessages.push({
            role: message.author,
            content: message.content,
            });
        });
        
        return openAIMessages;
    }

    // Set up parameters specific to the OpenAI Chat API
    getRequestParameters(text, parameters, prompt) {
        const { modelPromptText, modelPromptMessages, tokenLength, modelPrompt } = this.getCompiledPrompt(text, parameters, prompt);
        let { stream, tools, functions } = parameters;

        if (typeof tools === 'string') {
            tools = JSON.parse(tools);
        }
        
        if (typeof functions === 'string') {
            functions = JSON.parse(functions);
        }

        // Define the model's max token length
        const modelTargetTokenLength = this.getModelMaxPromptTokens();

        let requestMessages = modelPromptMessages || [{ "role": "user", "content": modelPromptText }];
        
        // Check if the messages are in Palm format and convert them to OpenAI format if necessary
        const isPalmFormat = requestMessages.some(message => 'author' in message);

        if (isPalmFormat) {
            const context = modelPrompt.context || '';
            const examples = modelPrompt.examples || [];
            requestMessages = this.convertPalmToOpenAIMessages(context, examples, modelPromptMessages);
        }
    
        // Check if the token length exceeds the model's max token length
        if (tokenLength > modelTargetTokenLength && this.promptParameters?.manageTokenLength) {
            // Remove older messages until the token length is within the model's limit
            requestMessages = this.truncateMessagesToTargetLength(requestMessages, modelTargetTokenLength);
        }

        const requestParameters = {
        messages: requestMessages,
        temperature: this.temperature ?? 0.7,
        ...(stream !== undefined ? { stream } : {}),
        ...(tools && tools.length > 0 ? { tools, tool_choice: parameters.tool_choice || 'auto' } : {}),
        ...(functions && functions.length > 0 ? { functions } : {}),
        };
    
        return requestParameters;
    }

    // Assemble and execute the request to the OpenAI Chat API
    async execute(text, parameters, prompt, cortexRequest) {
        const requestParameters = this.getRequestParameters(text, parameters, prompt);

        cortexRequest.data = { ...(cortexRequest.data || {}), ...requestParameters };
        cortexRequest.params = {}; // query params

        return this.executeRequest(cortexRequest);
    }

    // Parse the response from the OpenAI Chat API
    parseResponse(data) {
        if(!data) return "";
        const { choices } = data;
        if (!choices || !choices.length) {
            return data;
        }

        // if we got a choices array back with more than one choice, return the whole array
        if (choices.length > 1) {
            return choices;
        }

        const choice = choices[0];
        const message = choice.message;
        if (!message) {
            return null;
        }

        // Create standardized CortexResponse object
        const cortexResponse = new CortexResponse({
            output_text: message.content || "",
            finishReason: choice.finish_reason || 'stop',
            usage: data.usage || null,
            metadata: {
                model: this.modelName
            }
        });

        // Handle tool calls
        if (message.tool_calls) {
            cortexResponse.toolCalls = message.tool_calls;
        } else if (message.function_call) {
            cortexResponse.functionCall = message.function_call;
        }

        return cortexResponse;
    }

    // Override the logging function to display the messages and responses
    logRequestData(data, responseData, prompt) {
        const { stream, messages } = data;
        if (messages && messages.length > 1) {
            logger.info(`[chat request sent containing ${messages.length} messages]`);
            let totalLength = 0;
            let totalUnits;
            messages.forEach((message, index) => {
                //message.content string or array
                const content = message.content === undefined ? JSON.stringify(message) : (Array.isArray(message.content) ? message.content.map(item => {
                    return JSON.stringify(item);
                }).join(', ') : message.content);
                const { length, units } = this.getLength(content);
                const displayContent = this.shortenContent(content);

                logger.verbose(`message ${index + 1}: role: ${message.role}, ${units}: ${length}, content: "${displayContent}"`);
                totalLength += length;
                totalUnits = units;
            });
            logger.info(`[chat request contained ${totalLength} ${totalUnits}]`);
        } else {
            const message = messages[0];
            const content = Array.isArray(message.content) ? message.content.map(item => {
                return JSON.stringify(item);
            }).join(', ') : message.content;
            const { length, units } = this.getLength(content);
            logger.info(`[request sent containing ${length} ${units}]`);
            logger.verbose(`${this.shortenContent(content)}`);
        }
    
        if (stream) {
            logger.info(`[response received as an SSE stream]`);
        } else {           
            if (typeof responseData === 'string') {
                const { length, units } = this.getLength(responseData);
                logger.info(`[response received containing ${length} ${units}]`);
                logger.verbose(`${this.shortenContent(responseData)}`);
            } else {
                logger.info(`[response received containing object]`);
                logger.verbose(`${JSON.stringify(responseData)}`);
            }
        }

        prompt && prompt.debugInfo && (prompt.debugInfo += `\n${JSON.stringify(data)}`);
    }
}

export default OpenAIChatPlugin;
