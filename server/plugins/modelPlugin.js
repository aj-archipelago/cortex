// ModelPlugin.js
import HandleBars from '../../lib/handleBars.js';
import { executeRequest } from '../../lib/requestExecutor.js';
import { encode } from '../../lib/encodeCache.js';
import { getFirstNToken } from '../chunker.js';
import logger, { obscureUrlParams } from '../../lib/logger.js';
import { config } from '../../config.js';
import axios from 'axios';
import { extractValueFromTypeSpec } from '../typeDef.js';

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
            this.promptParameters[k] = extractValueFromTypeSpec(v?.default ?? v);
        }
        if (pathway.inputParameters) {
            for (const [k, v] of Object.entries(pathway.inputParameters)) {
                this.promptParameters[k] = extractValueFromTypeSpec(v?.default ?? v);
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

    truncateMessagesToTargetLength(messages, targetTokenLength = null, maxMessageTokenLength = Infinity) {
        const truncationMarker = '[...]';
        const truncationMarkerTokenLength = encode(truncationMarker).length;
        const messageOverhead = 4; // Per-message overhead tokens
        const conversationOverhead = 3; // Conversation formatting overhead

        // Helper function to truncate text content
        const truncateTextContent = (text, maxTokens) => {
            if (this.safeGetEncodedLength(text) <= maxTokens) return text;
            return getFirstNToken(text, maxTokens - truncationMarkerTokenLength) + truncationMarker;
        };

        // Helper function to truncate multimodal content
        const truncateMultimodalContent = (content, maxTokens) => {
            const newContent = [];
            let contentTokensUsed = 0;
            let truncationAdded = false;
            
            for (let item of content) {
                // Convert string items to text objects
                if (typeof item === 'string') {
                    item = { type: 'text', text: item };
                }

                // Handle text items
                if (item.type === 'text') {
                    if (contentTokensUsed < maxTokens) {
                        const remainingTokens = maxTokens - contentTokensUsed;
                        
                        if (this.safeGetEncodedLength(item.text) <= remainingTokens) {
                            // Text fits completely
                            newContent.push(item);
                            contentTokensUsed += this.safeGetEncodedLength(item.text);
                        } else {
                            // Truncate text
                            const truncatedText = getFirstNToken(item.text, remainingTokens);
                            newContent.push({ type: 'text', text: truncatedText + truncationMarker });
                            contentTokensUsed += this.safeGetEncodedLength(truncatedText) + truncationMarkerTokenLength;
                            truncationAdded = true;
                            break;
                        }
                    }
                } 
                // Handle image items - prioritize them but account for their token usage
                else if (item.type === 'image_url') {
                    const imageTokens = 100; // Estimated token count for images
                    if (contentTokensUsed + imageTokens <= maxTokens) {
                        newContent.push(item);
                        contentTokensUsed += imageTokens;
                    }
                }
                // Other non-text content
                else {
                    newContent.push(item);
                }
            }
            
            // Add truncation marker if needed and not already added
            if (content.length > newContent.length && !truncationAdded) {
                newContent.push({ type: 'text', text: truncationMarker });
                contentTokensUsed += truncationMarkerTokenLength;
            }
            
            return { content: newContent, tokensUsed: contentTokensUsed };
        };

        // Helper function to truncate any message content
        const truncateMessageContent = (message, availableTokens, maxPerMessageTokens) => {
            // Calculate max content tokens (minimum of available tokens or max per message)
            const maxContentTokens = Math.min(
                availableTokens,
                maxPerMessageTokens - message.roleTokens - messageOverhead
            );
            
            const messageToAdd = { ...message };
            delete messageToAdd.tokenLength;
            delete messageToAdd.roleTokens;
            delete messageToAdd.contentTokens;
            // Keep originalIndex for sorting later
            
            let contentTokensUsed = 0;
            
            // Handle extreme constraints (zero or negative token availability)
            if (maxContentTokens <= 0) {
                // For extreme constraints, just add truncation marker or empty content
                if (typeof message.content === 'string') {
                    messageToAdd.content = truncationMarker;
                    contentTokensUsed = truncationMarkerTokenLength;
                } else if (Array.isArray(message.content)) {
                    messageToAdd.content = [{ type: 'text', text: truncationMarker }];
                    contentTokensUsed = truncationMarkerTokenLength;
                }
                
                const totalTokensUsed = message.roleTokens + contentTokensUsed + messageOverhead;
                return { message: messageToAdd, tokensUsed: totalTokensUsed };
            }
            
            // Truncate text content
            if (typeof message.content === 'string') {
                // Leave room for truncation marker if needed
                const contentSpace = Math.max(0, maxContentTokens);
                messageToAdd.content = truncateTextContent(message.content, contentSpace);
                contentTokensUsed = this.safeGetEncodedLength(messageToAdd.content);
            } 
            // Handle multimodal content
            else if (Array.isArray(message.content)) {
                const result = truncateMultimodalContent(message.content, maxContentTokens);
                messageToAdd.content = result.content;
                contentTokensUsed = result.tokensUsed;
                
                // Skip message if no content after truncation
                if (result.content.length === 0) {
                    messageToAdd.content = [{ type: 'text', text: truncationMarker }];
                    contentTokensUsed = truncationMarkerTokenLength;
                }
            }
            
            const totalTokensUsed = message.roleTokens + contentTokensUsed + messageOverhead;
            return { message: messageToAdd, tokensUsed: totalTokensUsed };
        };

        // If no messages, return empty array
        if (!messages || messages.length === 0) return [];

        // If there's no target token length, get it from the model
        if (!targetTokenLength) {
            targetTokenLength = this.getModelMaxPromptTokens();
        }
        
        // First check if all messages already fit within the target length
        const initialTokenCount = this.countMessagesTokens(messages);
        if (initialTokenCount <= targetTokenLength && maxMessageTokenLength === Infinity) {
            return messages;
        }

        // Calculate safety margin
        const safetyMarginPercent = targetTokenLength > 1000 ? 0.05 : 0.02; // 5% or 2% for small targets
        const safetyMarginMinimum = Math.min(20, Math.floor(targetTokenLength * 0.01)); // At most 1% for minimum
        const safetyMargin = Math.max(safetyMarginMinimum, Math.round(targetTokenLength * safetyMarginPercent));
        
        // Adjust targetTokenLength to account for overheads and safety margin
        const effectiveTargetLength = Math.max(0, targetTokenLength - conversationOverhead - safetyMargin);

        // Calculate token lengths for each message and track original index
        const messagesWithTokens = messages.map((message, index) => {
            // Count tokens for the role/author
            const roleTokens = this.safeGetEncodedLength(message.role || message.author || "");

            // Count tokens for content
            const tokenLength = this.countMessagesTokens([message]);
            
            return {
                ...message,
                roleTokens: roleTokens,
                contentTokens: tokenLength - roleTokens - messageOverhead,
                tokenLength: tokenLength,
                originalIndex: index // Keep track of original position
            };
        });

        // Sort messages by priority: last message, then system messages (newest first), then others (newest first)
        const lastMessage = messagesWithTokens.length > 0 ? messagesWithTokens[messagesWithTokens.length - 1] : null;
        const systemMessages = messagesWithTokens
            .filter(m => (m.role === 'system' || m.author === 'system') && m !== lastMessage)
            .reverse();
        const otherMessages = messagesWithTokens
            .filter(m => (m.role !== 'system' && m.author !== 'system') && m !== lastMessage)
            .reverse();

        // Build prioritized array
        const prioritizedMessages = [];
        if (lastMessage) prioritizedMessages.push(lastMessage);
        prioritizedMessages.push(...systemMessages, ...otherMessages);

        // Track used tokens and build result
        let usedTokens = 0;
        const result = [];

        // Process messages in priority order
        for (const message of prioritizedMessages) {
            // Calculate how many tokens we have available
            const remainingTokens = effectiveTargetLength - usedTokens;
            
            // If we have very few tokens left, skip this message
            const minimumUsableTokens = 10; 
            if (remainingTokens < minimumUsableTokens) break;
            
            const { message: truncatedMessage, tokensUsed } = truncateMessageContent(
                message, 
                remainingTokens, 
                maxMessageTokenLength
            );
            
            if (truncatedMessage) {
                result.push(truncatedMessage);
                usedTokens += tokensUsed;
            }
            
            // If we're close to target token length, stop processing more messages
            const cutoffThreshold = Math.min(20, Math.floor(effectiveTargetLength * 0.01));
            if (effectiveTargetLength - usedTokens < cutoffThreshold) break;
        }

        // Handle edge case: No messages fit within the limit
        if (result.length === 0 && prioritizedMessages.length > 0) {
            // Force at least one message (highest priority) to fit
            const highestPriorityMessage = prioritizedMessages[0];
            const availableForContent = effectiveTargetLength - highestPriorityMessage.roleTokens - messageOverhead;
            
            if (availableForContent > truncationMarkerTokenLength) {
                const { message: truncatedMessage } = truncateMessageContent(
                    highestPriorityMessage,
                    availableForContent,
                    Infinity // No per-message limit in this case
                );
                
                if (truncatedMessage) {
                    result.push(truncatedMessage);
                }
            }
        }
        
        // Before returning, verify we're under the limit and fix if needed
        const finalTokenCount = this.countMessagesTokens(result);
        if (finalTokenCount > targetTokenLength && result.length > 0) {
            const lastResult = result[result.length - 1];
            
            // Aggressively truncate the last message more
            if (typeof lastResult.content === 'string') {
                const overage = finalTokenCount - targetTokenLength + safetyMargin/2;
                const currentLength = this.safeGetEncodedLength(lastResult.content);
                const newLength = Math.max(20, currentLength - overage);
                
                lastResult.content = getFirstNToken(lastResult.content, newLength - truncationMarkerTokenLength) + truncationMarker;
            }
            // For multimodal content, just remove all but the first text item
            else if (Array.isArray(lastResult.content)) {
                const firstTextIndex = lastResult.content.findIndex(item => item.type === 'text');
                if (firstTextIndex >= 0) {
                    const firstTextItem = lastResult.content[firstTextIndex];
                    // Keep only this text item and truncate it
                    const truncatedText = getFirstNToken(firstTextItem.text, 20) + truncationMarker;
                    lastResult.content = [{ type: 'text', text: truncatedText }];
                }
            }
        }
        
        // Sort by original index to restore original order
        result.sort((a, b) => a.originalIndex - b.originalIndex);
        
        // Remove originalIndex property from result objects
        return result.map(message => {
            const { originalIndex, ...messageWithoutIndex } = message;
            return messageWithoutIndex;
        });
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
        // Preserve null for assistant messages with tool_calls (per OpenAI spec)
        expandedMessages.forEach((message) => {
            if (typeof message === 'object' && message.content === null) {
                // Assistant messages with tool_calls can have null content per OpenAI spec
                if (message.role === 'assistant' && message.tool_calls) {
                    // Keep null as-is
                } else {
                    message.content = '';
                }
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

            const response = await executeRequest(cortexRequest);
            
            // Add null check and default values for response
            if (!response) {
                throw new Error('Request failed - no response received');
            }

            const { data: responseData, duration: requestDuration } = response;
            
            // Validate response data
            if (!responseData) {
                throw new Error('Request failed - no data in response');
            }

            const errorData = Array.isArray(responseData) ? responseData[0] : responseData;
            if (errorData && errorData.error) {
                const newError = new Error(errorData.error.message);
                newError.data = errorData;
                throw newError;
            }
        
            this.logAIRequestFinished(requestDuration || 0);
            const parsedData = this.parseResponse(responseData);
            this.logRequestData(data, parsedData, prompt);

            return parsedData;
        } catch (error) {
            // Enhanced error logging
            const errorMessage = error?.response?.data?.message
                                 ?? error?.response?.data?.error?.message
                                 ?? error?.message
                                 ?? String(error);
            
            // Log the full error details for debugging
            logger.error(`Error in executeRequest for ${this.pathwayName}: ${errorMessage}`);
            if (error.response) {
                logger.error(`Response status: ${error.response.status}`);
                logger.error(`Response headers: ${JSON.stringify(error.response.headers)}`);
                if (error.response.data) {
                    logger.error(`Response data: ${JSON.stringify(error.response.data)}`);
                }
            }
            if (error.data) {
                logger.error(`Additional error data: ${JSON.stringify(error.data)}`);
            }
            if (error.stack) {
                logger.error(`Error stack: ${error.stack}`);
            }

            // Throw a more informative error
            throw new Error(`Execution failed for ${this.pathwayName}: ${errorMessage}`);
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
            } catch (error) {
                throw new Error(`Could not parse stream data: ${error}`);
            }

            // error can be in different places in the message
            const streamError = parsedMessage?.error || parsedMessage?.choices?.[0]?.delta?.content?.error || parsedMessage?.choices?.[0]?.text?.error;
            if (streamError) {
                throw new Error(streamError);
            }

            // Set the data for the event
            requestProgress.data = event.data;

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

    countMessagesTokens(messages) {
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return 0;
        }

        let totalTokens = 0;

        for (const message of messages) {
            // Count tokens for role/author
            const role = message.role || message.author || "";
            if (role) {
                totalTokens += this.safeGetEncodedLength(role);
            }

            // Count tokens for content
            if (typeof message.content === 'string') {
                totalTokens += this.safeGetEncodedLength(message.content);
            } else if (Array.isArray(message.content)) {
                // Handle multimodal content
                for (const item of message.content) {
                    // item can be a string or an object
                    if (typeof item === 'string') {
                        totalTokens += this.safeGetEncodedLength(item);
                    } else if (item.type === 'text') {
                        totalTokens += this.safeGetEncodedLength(item.text);
                    } else if (item.type === 'image_url') {
                        // Most models use ~85-130 tokens per image, but this varies by model
                        totalTokens += 100;
                    }
                }
            }

            // Add per-message overhead (typically 3-4 tokens per message)
            totalTokens += 4;
        }

        // Add conversation formatting overhead
        totalTokens += 3;

        return totalTokens;
    }

}

export default ModelPlugin;

  