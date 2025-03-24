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

    truncateMessagesToTargetLength(messages, targetTokenLength = null, maxMessageTokenLength = Infinity) {
        const truncationMarker = '[...]';
        const truncationMarkerTokenLength = encode(truncationMarker).length;

        // If no messages, return empty array
        if (!messages || messages.length === 0) return [];

        // If there's no target token length, get it from the model
        if (!targetTokenLength) {
            targetTokenLength = this.getModelMaxPromptTokens();
        }
        
        // First check if all messages already fit within the target length
        const initialTokenCount = this.countMessagesTokens(messages);
        if (initialTokenCount <= targetTokenLength && maxMessageTokenLength == Infinity) {
            return messages;
        }

        // Calculate safety margin as a percentage of target length with a minimum value
        // Scale down the percentage for small targets
        const safetyMarginPercent = targetTokenLength > 1000 ? 0.05 : 0.02; // 5% or 2% for small targets
        const safetyMarginMinimum = Math.min(20, Math.floor(targetTokenLength * 0.01)); // At most 1% for minimum
        const safetyMargin = Math.max(safetyMarginMinimum, Math.round(targetTokenLength * safetyMarginPercent));
        
        // Adjust targetTokenLength to account for conversation formatting overhead (3 tokens)
        const conversationOverhead = 3;
        const effectiveTargetLength = Math.max(0, targetTokenLength - conversationOverhead - safetyMargin);

        // Calculate token lengths for each message and track original index
        const messagesWithTokens = messages.map((message, index) => {
            // Count tokens for the role/author
            const roleTokens = this.safeGetEncodedLength(message.role || message.author || "");

            // Add per-message overhead (4 tokens)
            const messageOverhead = 4;

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

        // Single pass: process messages in priority order
        for (const message of prioritizedMessages) {
            // Calculate how many tokens we have available
            const remainingTokens = effectiveTargetLength - usedTokens;
            
            // If we have very few tokens left, skip this message
            // For very small messages, we need to be less strict
            const minimumUsableTokens = 10; 
            if (remainingTokens < minimumUsableTokens) break;
            
            // Create a copy of the message to modify, but keep the originalIndex
            let messageToAdd = { ...message };
            delete messageToAdd.tokenLength;
            delete messageToAdd.roleTokens;
            delete messageToAdd.contentTokens;
            // Keep originalIndex for sorting later
            
            const roleTokens = message.roleTokens;
            const messageOverhead = 4;
            // Calculate available tokens for content
            const availableContentTokens = remainingTokens - roleTokens - messageOverhead;
            
            // Skip if we can't even fit the role + minimum content
            if (availableContentTokens <= 0) continue;
            
            // Determine if we need to truncate the content
            const needsTruncation = message.contentTokens > availableContentTokens 
                               || message.contentTokens > (maxMessageTokenLength - roleTokens - messageOverhead);
            
            if (needsTruncation) {
                // Maximum content tokens (smallest of available tokens or max per message)
                const maxContentTokens = Math.min(
                    availableContentTokens,
                    maxMessageTokenLength - roleTokens - messageOverhead
                );
                
                // Truncate text content
                if (typeof message.content === 'string') {
                    // Calculate space for content (leave room for truncation marker if needed)
                    const contentSpace = Math.max(truncationMarkerTokenLength, maxContentTokens - truncationMarkerTokenLength);
                    const truncatedContent = contentSpace > truncationMarkerTokenLength ? getFirstNToken(message.content, contentSpace) : "";
                    
                    // Only add truncation marker if we actually truncated
                    if (truncatedContent.length < message.content.length) {
                        messageToAdd.content = truncatedContent + truncationMarker;
                    } else {
                        messageToAdd.content = truncatedContent;
                    }
                    
                    const updatedContentTokens = this.safeGetEncodedLength(messageToAdd.content);
                    usedTokens += roleTokens + updatedContentTokens + messageOverhead;
                } 
                // Handle multimodal content
                else if (Array.isArray(message.content)) {
                    const newContent = [];
                    let contentTokensUsed = 0;
                    const contentLimit = maxContentTokens - truncationMarkerTokenLength;
                    let truncationAdded = false;
                    
                    for (let item of message.content) {
                        // items might be strings or objects
                        if (typeof item === 'string') {
                            item = { type: 'text', text: item };
                        }

                        // Handle text items
                        if (item.type === 'text') {
                            if (contentTokensUsed < contentLimit) {
                                const remainingTokens = contentLimit - contentTokensUsed;
                                
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
                            if (contentTokensUsed + imageTokens <= contentLimit) {
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
                    if (message.content.length > newContent.length && !truncationAdded) {
                        newContent.push({ type: 'text', text: truncationMarker });
                        contentTokensUsed += truncationMarkerTokenLength;
                    }
                    
                    if (newContent.length > 0) {
                        messageToAdd.content = newContent;
                        usedTokens += roleTokens + contentTokensUsed + messageOverhead;
                    } else {
                        continue; // Skip message if no content after truncation
                    }
                }
            } else {
                // Message fits without truncation
                usedTokens += message.tokenLength;
            }
            
            result.push(messageToAdd);
            
            // If we're close to target token length, stop processing more messages earlier
            // Use a proportional cutoff to ensure we don't get too close to the limit
            const cutoffThreshold = Math.min(20, Math.floor(effectiveTargetLength * 0.01));
            if (effectiveTargetLength - usedTokens < cutoffThreshold) break;
        }

        // Handle edge case: No messages fit within the limit
        if (result.length === 0 && prioritizedMessages.length > 0) {
            // Force at least one message (highest priority) to fit
            const highestPriorityMessage = prioritizedMessages[0];
            const roleTokens = highestPriorityMessage.roleTokens;
            const messageOverhead = 4;
            const availableForContent = effectiveTargetLength - roleTokens - messageOverhead;
            
            if (availableForContent > truncationMarkerTokenLength) {
                let messageToAdd = { ...highestPriorityMessage };
                delete messageToAdd.tokenLength;
                delete messageToAdd.roleTokens;
                delete messageToAdd.contentTokens;
                // Keep originalIndex for sorting later
                
                // Truncate content to fit available space
                if (typeof highestPriorityMessage.content === 'string') {
                    const truncatedContent = getFirstNToken(
                        highestPriorityMessage.content, 
                        availableForContent - truncationMarkerTokenLength
                    );
                    messageToAdd.content = truncatedContent + truncationMarker;
                    result.push(messageToAdd);
                } else if (Array.isArray(highestPriorityMessage.content)) {
                    const newContent = [];
                    let contentTokensUsed = 0;
                    const contentLimit = availableForContent - truncationMarkerTokenLength;
                    let truncationAdded = false;
                    
                    for (const item of highestPriorityMessage.content) {
                        if (item.type === 'text') {
                            if (contentTokensUsed < contentLimit) {
                                const remainingTokens = contentLimit - contentTokensUsed;
                                const tokenCount = this.safeGetEncodedLength(item.text);
                                
                                if (tokenCount <= remainingTokens) {
                                    // Text fits completely
                                    newContent.push(item);
                                    contentTokensUsed += tokenCount;
                                } else {
                                    // Truncate text
                                    const truncatedText = getFirstNToken(item.text, remainingTokens);
                                    newContent.push({ type: 'text', text: truncatedText + truncationMarker });
                                    contentTokensUsed += this.safeGetEncodedLength(truncatedText) + truncationMarkerTokenLength;
                                    truncationAdded = true;
                                    break;
                                }
                            }
                        } else if (item.type === 'image_url') {
                            const imageTokens = 100;
                            if (contentTokensUsed + imageTokens <= contentLimit) {
                                newContent.push(item);
                                contentTokensUsed += imageTokens;
                            }
                        } else {
                            newContent.push(item);
                        }
                    }
                    
                    // Add truncation marker if needed and not already added
                    if (highestPriorityMessage.content.length > newContent.length && !truncationAdded) {
                        newContent.push({ type: 'text', text: truncationMarker });
                        contentTokensUsed += truncationMarkerTokenLength;
                    }
                    
                    if (newContent.length > 0) {
                        messageToAdd.content = newContent;
                        result.push(messageToAdd);
                    }
                }
            }
        }
        
        // Before returning, verify we're under the limit with countMessagesTokens
        // If we're still over, aggressively truncate the last message
        const finalTokenCount = this.countMessagesTokens(result);
        if (finalTokenCount > targetTokenLength && result.length > 0) {
            const lastResult = result[result.length - 1];
            
            // If the last message has string content, truncate it more
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

  