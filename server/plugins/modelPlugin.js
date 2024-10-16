// ModelPlugin.js
import HandleBars from '../../lib/handleBars.js';
import { executeRequest } from '../../lib/requestExecutor.js';
import { encode } from '../../lib/encodeCache.js';
import { getFirstNToken } from '../chunker.js';
import logger, { obscureUrlParams } from '../../lib/logger.js';
import { config } from '../../config.js';

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_RETURN_TOKENS = 256;
const DEFAULT_PROMPT_TOKEN_RATIO = 0.5;

class ModelPlugin {
    constructor(pathway, model) {
        this.modelName = model.name;
        this.model = model;
        this.config = config;
        this.environmentVariables = config.getEnv();
        this.temperature = pathway.temperature;
        this.pathwayPrompt = pathway.prompt;
        this.pathwayName = pathway.name;
        this.promptParameters = {};
        this.isMultiModal = false;

        // Make all of the parameters defined on the pathway itself available to the prompt
        for (const [k, v] of Object.entries(pathway)) {
            this.promptParameters[k] = v?.default ?? v;
        }
        if (pathway.inputParameters) {
            for (const [k, v] of Object.entries(pathway.inputParameters)) {
                this.promptParameters[k] = v?.default ?? v;
            }
        }

        this.requestCount = 0;
    }

    truncateMessagesToTargetLength(messages, targetTokenLength) {
        // Calculate the token length of each message
        const tokenLengths = messages.map((message) => ({
            message,
            tokenLength: encode(this.messagesToChatML([message], false)).length,
        }));
    
        // Calculate the total token length of all messages
        let totalTokenLength = tokenLengths.reduce(
            (sum, { tokenLength }) => sum + tokenLength,
            0
        );
    
        // If we're already under the target token length, just bail
        if (totalTokenLength <= targetTokenLength) return messages;
    
        // Remove and/or truncate messages until the target token length is reached
        let index = 0;
        while ((totalTokenLength > targetTokenLength) && (index < tokenLengths.length)) {
            const message = tokenLengths[index].message;

            // Skip system messages
            if (message?.role === 'system') {
                index++;
                continue;
            }

            const currentTokenLength = tokenLengths[index].tokenLength;
            
            if (totalTokenLength - currentTokenLength >= targetTokenLength) {
                // Remove the message entirely if doing so won't go below the target token length
                totalTokenLength -= currentTokenLength;
                tokenLengths.splice(index, 1);
            } else {
                // Truncate the message to fit the remaining target token length
                const emptyContentLength = encode(this.messagesToChatML([{ ...message, content: '' }], false)).length;
                const otherMessageTokens = totalTokenLength - currentTokenLength;
                const tokensToKeep = targetTokenLength - (otherMessageTokens + emptyContentLength);

                if (tokensToKeep <= 0 || Array.isArray(message?.content)) {  
                    // If the message needs to be empty to make the target, remove it entirely
                    totalTokenLength -= currentTokenLength;
                    tokenLengths.splice(index, 1);
                    if(tokenLengths.length == 0){
                        throw new Error(`Unable to process your request as your single message content is too long. Please try again with a shorter message.`);
                    }
                } else {
                    // Otherwise, update the message and token length
                    const truncatedContent = getFirstNToken(message?.content ?? message, tokensToKeep);
                    const truncatedMessage = { ...message, content: truncatedContent };

                    tokenLengths[index] = {
                        message: truncatedMessage,
                        tokenLength: encode(this.messagesToChatML([ truncatedMessage ], false)).length
                    }

                    // calculate the length again to keep us honest
                    totalTokenLength = tokenLengths.reduce(
                        (sum, { tokenLength }) => sum + tokenLength,
                        0
                    );

                    index++;
                }
            }
        }
    
        // Return the modified messages array
        return tokenLengths.map(({ message }) => message);
    }
    
    //convert a messages array to a simple chatML format
    messagesToChatML(messages, addAssistant = true) {
        let output = "";
        if (messages && messages.length) {
            for (let message of messages) {
                output += ((message.author || message.role) && (message.content || message.content === '')) ? `<|im_start|>${(message.author || message.role)}\n${message.content}\n<|im_end|>\n` : `${message}\n`;
            }
            // you always want the assistant to respond next so add a
            // directive for that
            if (addAssistant) {
                output += "<|im_start|>assistant\n";
            }
        }
        return output;
    }

    // compile the Prompt    
    getCompiledPrompt(text, parameters, prompt) {
        
        const mergeParameters = (promptParameters, parameters) => {
            let result = { ...promptParameters };
            for (let key in parameters) {
                if (parameters[key] !== null) result[key] = parameters[key];
            }
            return result;
        }

        const combinedParameters = mergeParameters(this.promptParameters, parameters);
        const modelPrompt = this.getModelPrompt(prompt, parameters);
        const modelPromptText = modelPrompt.prompt ? HandleBars.compile(modelPrompt.prompt)({ ...combinedParameters, text }) : '';
        const modelPromptMessages = this.getModelPromptMessages(modelPrompt, combinedParameters, text);
        const modelPromptMessagesML = this.messagesToChatML(modelPromptMessages);

        if (modelPromptMessagesML) {
            return { modelPromptMessages, tokenLength: encode(modelPromptMessagesML).length, modelPrompt };
        } else {
            return { modelPromptText, tokenLength: encode(modelPromptText).length, modelPrompt };
        }
    }

    getModelMaxTokenLength() {
        return (this.promptParameters.maxTokenLength ?? this.model.maxTokenLength ?? DEFAULT_MAX_TOKENS);
    }

    getModelMaxReturnTokens() {
        return (this.promptParameters.maxReturnTokens ?? this.model.maxReturnTokens ?? DEFAULT_MAX_RETURN_TOKENS);
    }

    getPromptTokenRatio() {
        // TODO: Is this the right order of precedence? inputParameters should maybe be second?
        return this.promptParameters.inputParameters?.tokenRatio ?? this.promptParameters.tokenRatio ?? DEFAULT_PROMPT_TOKEN_RATIO;
    }

    getModelPrompt(prompt, parameters) {
        if (typeof(prompt) === 'function') {
            return prompt(parameters);
        } else {
            return prompt;
        }
    }

    getModelPromptMessages(modelPrompt, combinedParameters, text) {
        if (!modelPrompt.messages) {
            return null;
        }
    
        // First run handlebars compile on the pathway messages
        const compiledMessages = modelPrompt.messages.map((message) => {
            if (message.content) {
                const compileText = HandleBars.compile(message.content);
                return {
                    ...message,
                    content: compileText({ ...combinedParameters, text }),
                };
            } else {
                return message;
            }
        });
    
        // Next add in any parameters that are referenced by name in the array
        const expandedMessages = compiledMessages.flatMap((message) => {
            if (typeof message === 'string') {
                const match = message.match(/{{(.+?)}}/);
                const placeholder = match ? match[1] : null;
                if (placeholder === null) {
                    return message;
                } else {
                    return combinedParameters[placeholder] || [];
                }
            } else {
                return [message];
            }
        });
     
        // Clean up any null messages if they exist
        expandedMessages.forEach((message) => {
            if (typeof message === 'object' && message.content === null) {
                message.content = '';
            }
        });

        // Flatten content arrays for non-multimodal models
        if (!this.isMultiModal) {
            expandedMessages.forEach(message => {
                if (Array.isArray(message?.content)) {
                    message.content = message.content.join("\n");
                }
            });
        }
        
        return expandedMessages;
    }

    requestUrl() {
        const generateUrl = HandleBars.compile(this.model.url);
        return generateUrl({ ...this.model, ...this.environmentVariables, ...this.config });
    }

    // Default response parsing
    parseResponse(data) { return data; }

    // Default simple logging
    logRequestStart() {
        this.requestCount++;
        const logMessage = `>>> [${this.requestId}: ${this.pathwayName}.${this.requestCount}] request`;
        const header = '>'.repeat(logMessage.length);
        logger.info(`${header}`);
        logger.info(`${logMessage}`);
        logger.info(`>>> Making API request to ${obscureUrlParams(this.url)}`);
    }

    logAIRequestFinished(requestDuration) {
        const logMessage = `<<< [${this.requestId}: ${this.pathwayName}] response - complete in ${requestDuration}ms - data:`;
        const header = '<'.repeat(logMessage.length);
        logger.info(`${header}`);
        logger.info(`${logMessage}`);
    }

    getLength(data) {
        const isProd = config.get('env') === 'production';
        let length = 0;
        let units = isProd ? 'characters' : 'tokens';
        if (data) {
           length = isProd ? data.length : encode(data).length;
        }
        return {length, units};
    }

    logRequestData(data, responseData, prompt) {
        const modelInput = data.prompt || (data.messages && data.messages[0].content) || (data.length > 0 && data[0].Text) || null;
    
        if (modelInput) {
            const { length, units } = this.getLength(modelInput);
            logger.info(`[request sent containing ${length} ${units}]`);
            logger.verbose(`${modelInput}`);
        }
    
        const responseText = JSON.stringify(responseData);
        const { length, units } = this.getLength(responseText);
        logger.info(`[response received containing ${length} ${units}]`);
        logger.verbose(`${responseText}`);
    
        prompt && prompt.debugInfo && (prompt.debugInfo += `\n${JSON.stringify(data)}`);
    }
    
    async executeRequest(cortexRequest) {
        try {
            const { url, data, pathway, requestId, prompt } = cortexRequest;
            this.url = url;
            this.requestId = requestId;
            this.pathwayName = pathway.name;
            this.pathwayPrompt = pathway.prompt;

            cortexRequest.cache = config.get('enableCache') && (pathway.enableCache || pathway.temperature == 0);
            this.logRequestStart();

            const { data: responseData, duration: requestDuration } = await executeRequest(cortexRequest);
            
            const errorData = Array.isArray(responseData) ? responseData[0] : responseData;
            if (errorData && errorData.error) {
                const newError = new Error(errorData.error.message);
                newError.data = errorData;
                throw newError;
            }
        
            this.logAIRequestFinished(requestDuration);
            const parsedData = this.parseResponse(responseData);
            this.logRequestData(data, parsedData, prompt);

            return parsedData;
        } catch (error) {
            // Log the error and continue
            logger.error(`Error in executeRequest for ${this.pathwayName}: ${error.message || error}`);
            if (error.data) {
                logger.error(`Additional error data: ${JSON.stringify(error.data)}`);
            }
            throw new Error(`Execution failed for ${this.pathwayName}: ${error.message || error}`);
        }
    }

    processStreamEvent(event, requestProgress) {
        // check for end of stream or in-stream errors
        if (event.data.trim() === '[DONE]') {
            requestProgress.progress = 1;
        } else {
            let parsedMessage;
            try {
                parsedMessage = JSON.parse(event.data);
                requestProgress.data = event.data;
            } catch (error) {
                throw new Error(`Could not parse stream data: ${error}`);
            }

            // error can be in different places in the message
            const streamError = parsedMessage?.error || parsedMessage?.choices?.[0]?.delta?.content?.error || parsedMessage?.choices?.[0]?.text?.error;
            if (streamError) {
                throw new Error(streamError);
            }

            // finish reason can be in different places in the message
            const finishReason = parsedMessage?.choices?.[0]?.finish_reason || parsedMessage?.candidates?.[0]?.finishReason;
            if (finishReason?.toLowerCase() === 'stop') {
                requestProgress.progress = 1;
            } else {
                if (finishReason?.toLowerCase() === 'safety') {
                    const safetyRatings = JSON.stringify(parsedMessage?.candidates?.[0]?.safetyRatings) || '';
                    logger.warn(`Request ${this.requestId} was blocked by the safety filter. ${safetyRatings}`);
                    requestProgress.data = `\n\nResponse blocked by safety filter: ${safetyRatings}`;
                    requestProgress.progress = 1;
                }
            }
        }
        return requestProgress;
    }


}

export default ModelPlugin;

  