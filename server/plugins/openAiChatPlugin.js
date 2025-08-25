// OpenAIChatPlugin.js
import ModelPlugin from './modelPlugin.js';
import logger from '../../lib/logger.js';

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
        const { stream, tools, tool_choice, functions, function_call } = parameters;
    
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

        // Helper function to convert stringified parameters back to objects
        const parseToolsParameter = (toolsParam) => {
            if (!toolsParam || !Array.isArray(toolsParam)) return toolsParam;
            
            return toolsParam.map(tool => {
                if (typeof tool === 'object' && tool.function && typeof tool.function.parameters === 'string') {
                    try {
                        return {
                            ...tool,
                            function: {
                                ...tool.function,
                                parameters: JSON.parse(tool.function.parameters)
                            }
                        };
                    } catch (e) {
                        logger.warn(`Failed to parse tool function parameters: ${e.message}`);
                        return tool;
                    }
                }
                return tool;
            });
        };

        // Helper function to convert stringified function parameters back to objects
        const parseFunctionsParameter = (functionsParam) => {
            if (!functionsParam || !Array.isArray(functionsParam)) return functionsParam;
            
            return functionsParam.map(func => {
                if (typeof func === 'object' && func.parameters && typeof func.parameters === 'string') {
                    try {
                        return {
                            ...func,
                            parameters: JSON.parse(func.parameters)
                        };
                    } catch (e) {
                        logger.warn(`Failed to parse function parameters: ${e.message}`);
                        return func;
                    }
                }
                return func;
            });
        };
    
        const requestParameters = {
            messages: requestMessages,
            temperature: this.temperature ?? 0.7,
            ...(stream !== undefined ? { stream } : {}),
        };

        // Add tools parameters if they exist, converting stringified parameters back to objects
        if (tools && Array.isArray(tools) && tools.length > 0) {
            requestParameters.tools = parseToolsParameter(tools);
        }
        if (tool_choice) {
            requestParameters.tool_choice = tool_choice;
        }
        if (functions && Array.isArray(functions) && functions.length > 0) {
            requestParameters.functions = parseFunctionsParameter(functions);
        }
        if (function_call) {
            requestParameters.function_call = function_call;
        }
    
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

        // otherwise, return the first choice
        const messageResult = choices[0].message && choices[0].message.content && choices[0].message.content.trim();
        return messageResult ?? null;
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
            const responseText = this.parseResponse(responseData);
            const { length, units } = this.getLength(responseText);
            logger.info(`[response received containing ${length} ${units}]`);
            logger.verbose(`${this.shortenContent(responseText)}`);
        }

        prompt && prompt.debugInfo && (prompt.debugInfo += `\n${JSON.stringify(data)}`);
    }
}

export default OpenAIChatPlugin;
