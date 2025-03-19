// ModelPlugin.js
import HandleBars from '../../lib/handleBars.js';
import { executeRequest } from '../../lib/requestExecutor.js';
import { encode } from '../../lib/encodeCache.js';
import { getFirstNToken } from '../chunker.js';
import logger, { obscureUrlParams } from '../../lib/logger.js';
import { config } from '../../config.js';
import axios from 'axios';

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_RETURN_TOKENS = 256;
const DEFAULT_PROMPT_TOKEN_RATIO = 1.0;
const DEFAULT_MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB default
const DEFAULT_ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

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
        this.allowedMIMETypes = model.allowedMIMETypes || DEFAULT_ALLOWED_MIME_TYPES;

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

    async validateImageUrl(url) {
        if (url.startsWith('data:')) {
            const [, mimeType = ""] = url.match(/data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+).*,.*/) || [];
            return this.allowedMIMETypes.includes(mimeType);
        }

        try {
            const headResponse = await axios.head(url, {
                timeout: 30000,
                maxRedirects: 5
            });

            const contentType = headResponse.headers['content-type'];
            if (!contentType || !this.allowedMIMETypes.includes(contentType)) {
                logger.warn(`Unsupported image type: ${contentType} - skipping image content.`);
                return false;
            }
            return true;
        } catch (e) {
            logger.error(`Failed to validate image URL: ${url}. ${e}`);
            return false;
        }
    }

    safeGetEncodedLength(data) {
        return encode(data).length;
    }

    truncateMessagesToTargetLength(messages, targetTokenLength) {
        const truncationMarker = '[truncated]';
        const truncationMarkerTokenLength = encode(truncationMarker).length;

        // If no messages, return empty array
        if (!messages || messages.length === 0 || !targetTokenLength) return [];

        // Calculate token length for each message
        const messagesWithTokens = messages.map((message, index) => ({
            message,
            tokenLength: this.safeGetEncodedLength(this.messagesToChatML([message], false)),
            role: message.role || message.author,
            originalIndex: index // Add original index for reliable ordering
        }));

        // Sort into our priority groups
        const mostRecentMessage = messagesWithTokens[messagesWithTokens.length - 1];
        const systemMessages = messagesWithTokens
            .filter(item => item.role === 'system')
            .reverse(); // Most recent first
        const otherMessages = messagesWithTokens
            .filter(item => item.role !== 'system' && item !== mostRecentMessage)
            .reverse(); // Most recent first

        // Helper function to truncate a message
        const truncateMessage = (item, remainingTokens, isRecent = false) => {
            const emptyContentLength = encode(this.messagesToChatML([{ ...item.message, content: '' }], false)).length;
            const tokensToKeep = remainingTokens - (emptyContentLength + truncationMarkerTokenLength);
            
            if (tokensToKeep > 0 && !Array.isArray(item.message?.content)) {
                // Truncate the message
                const truncatedContent = getFirstNToken(item.message?.content ?? item.message, tokensToKeep) + truncationMarker;
                const truncatedMessage = { ...item.message, content: truncatedContent };
                const truncatedTokenLength = this.safeGetEncodedLength(this.messagesToChatML([truncatedMessage], false));
                
                if (isRecent) {
                    logger.warn(`Most recent message truncated to fit token limit: ${truncatedContent.substring(0, 50)}...`);
                }
                
                return {
                    message: truncatedMessage,
                    tokenLength: truncatedTokenLength,
                    originalIndex: item.originalIndex
                };
            } else if (isRecent) {
                // For the most recent message, use placeholder if can't truncate
                logger.warn(`Most recent message too large to fit in token limit even after truncation. Using empty message.`);
                const emptyMessage = { ...item.message, content: '[Content too large to fit in context window]' };
                const emptyMessageTokenLength = this.safeGetEncodedLength(this.messagesToChatML([emptyMessage], false));
                
                return {
                    message: emptyMessage,
                    tokenLength: emptyMessageTokenLength,
                    originalIndex: item.originalIndex
                };
            }
            
            return null;
        };

        // Start with the most recent message, truncate if needed
        let resultMessages = [];
        let currentTokenLength = 0;
        
        // Process most recent message first - truncate if too large
        if (mostRecentMessage.tokenLength <= targetTokenLength) {
            // Most recent message fits completely
            resultMessages.push(mostRecentMessage);
            currentTokenLength = mostRecentMessage.tokenLength;
        } else {
            // Need to truncate most recent message
            const truncated = truncateMessage(mostRecentMessage, targetTokenLength, true);
            if (truncated) {
                resultMessages.push(truncated);
                currentTokenLength = truncated.tokenLength;
            }
        }
        
        // Add system messages
        for (const item of systemMessages) {
            if (currentTokenLength + item.tokenLength <= targetTokenLength) {
                resultMessages.push(item);
                currentTokenLength += item.tokenLength;
            } else {
                logger.warn(`System message too large to fit in token limit. Skipping: ${item.message.content?.substring(0, 50)}...`);
                break;
            }
        }
        
        // Add other messages from most recent to oldest until we hit the token limit
        for (const item of otherMessages) {
            if (currentTokenLength + item.tokenLength <= targetTokenLength) {
                // We can add the whole message
                resultMessages.push(item);
                currentTokenLength += item.tokenLength;
            } else {
                // Try to add a truncated version
                const truncated = truncateMessage(item, targetTokenLength - currentTokenLength);
                if (truncated) {
                    resultMessages.push(truncated);
                    // We've reached the limit
                    break;
                } else {
                    // Can't fit any more messages
                    break;
                }
            }
        }
        
        // Return the messages in original chronological order using the originalIndex
        return resultMessages
            .sort((a, b) => a.originalIndex - b.originalIndex)
            .map(item => item.message);
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
        let modelPromptText = '';
        
        try {
            modelPromptText = modelPrompt.prompt ? HandleBars.compile(modelPrompt.prompt)({ ...combinedParameters, text }) : '';
        } catch (error) {
            // If compilation fails, log the error and use the original prompt
            logger.warn(`Handlebars compilation failed in getCompiledPrompt: ${error.message}. Using original text.`);
            modelPromptText = modelPrompt.prompt || '';
        }
        
        const modelPromptMessages = this.getModelPromptMessages(modelPrompt, combinedParameters, text);
        const modelPromptMessagesML = this.messagesToChatML(modelPromptMessages);

        if (modelPromptMessagesML) {
            return { modelPromptMessages, tokenLength: this.safeGetEncodedLength(modelPromptMessagesML), modelPrompt };
        } else {
            return { modelPromptText, tokenLength: this.safeGetEncodedLength(modelPromptText), modelPrompt };
        }
    }

    getModelMaxTokenLength() {
        return (this.promptParameters.maxTokenLength ?? this.model.maxTokenLength ?? DEFAULT_MAX_TOKENS);
    }

    getModelMaxPromptTokens() {
        const hasMaxReturnTokens = this.promptParameters.maxReturnTokens !== undefined || this.model.maxReturnTokens !== undefined;
        
        const maxPromptTokens = hasMaxReturnTokens
            ? this.getModelMaxTokenLength() - this.getModelMaxReturnTokens()
            : Math.floor(this.getModelMaxTokenLength() * this.getPromptTokenRatio());
        
        return maxPromptTokens;
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
            if (message.content && typeof message.content === 'string') {
                try {
                    const compileText = HandleBars.compile(message.content);
                    return {
                        ...message,
                        content: compileText({ ...combinedParameters, text }),
                    };
                } catch (error) {
                    // If compilation fails, log the error and return the original content
                    logger.warn(`Handlebars compilation failed: ${error.message}. Using original text.`);
                    return message;
                }
            } else {
                return message;
            }
        });
    
        // Next add in any parameters that are referenced by name in the array
        const expandedMessages = compiledMessages.flatMap((message) => {
            if (typeof message === 'string') {
                try {
                    const match = message.match(/{{(.+?)}}/);
                    const placeholder = match ? match[1] : null;
                    if (placeholder === null) {
                        return message;
                    } else {
                        return combinedParameters[placeholder] || [];
                    }
                } catch (error) {
                    // If there's an error processing the string, return it as is
                    logger.warn(`Error processing message placeholder: ${error.message}. Using original text.`);
                    return message;
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
            if (isProd || data.length > 5000) {
                length = data.length;
                units = 'characters';
            } else {
                length = encode(data).length;
            }
        }
        return {length, units};
    }

    shortenContent(content, maxWords = 40) {
        if (!content || typeof content !== 'string') {
            return content;
        }
        const words = content.split(" ");
        if (words.length <= maxWords || logger.level === 'debug') {
            return content;
        }
        return words.slice(0, maxWords / 2).join(" ") +
            " ... " +
            words.slice(-maxWords / 2).join(" ");
    }

    logRequestData(data, responseData, prompt) {
        const modelInput = data.prompt || (data.messages && data.messages[0].content) || (data.length > 0 && data[0].Text) || null;
    
        if (modelInput) {
            const { length, units } = this.getLength(modelInput);
            logger.info(`[request sent containing ${length} ${units}]`);
            logger.verbose(`${this.shortenContent(modelInput)}`);
        }
    
        const responseText = JSON.stringify(responseData);
        const { length, units } = this.getLength(responseText);
        logger.info(`[response received containing ${length} ${units}]`);
        logger.verbose(`${this.shortenContent(responseText)}`);
    
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
            if (finishReason) {
                switch (finishReason.toLowerCase()) {
                    case 'safety':
                        const safetyRatings = JSON.stringify(parsedMessage?.candidates?.[0]?.safetyRatings) || '';
                        logger.warn(`Request ${this.requestId} was blocked by the safety filter. ${safetyRatings}`);
                        requestProgress.data = `\n\nResponse blocked by safety filter: ${safetyRatings}`;
                        requestProgress.progress = 1;
                        break;
                    default:
                        requestProgress.progress = 1;
                        break;
                }
            }
        }
        return requestProgress;
    }

    getModelMaxImageSize() {
        return (this.promptParameters.maxImageSize ?? this.model.maxImageSize ?? DEFAULT_MAX_IMAGE_SIZE);
    }

}

export default ModelPlugin;

  