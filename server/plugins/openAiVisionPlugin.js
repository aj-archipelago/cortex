import OpenAIChatPlugin from './openAiChatPlugin.js';
import logger from '../../lib/logger.js';
import { requestState } from '../requestState.js';
import { addCitationsToResolver } from '../../lib/pathwayTools.js';
import CortexResponse from '../../lib/cortexResponse.js';
import { sanitizeBase64 } from '../../lib/util.js';
function safeJsonParse(content) {
    try {
        const parsedContent = JSON.parse(content);
        return (typeof parsedContent === 'object' && parsedContent !== null) ? parsedContent : content;
    } catch (e) {
        return content;
    }
}

class OpenAIVisionPlugin extends OpenAIChatPlugin {

    constructor(pathway, model) {
        super(pathway, model);
        this.isMultiModal = true;
        this.pathwayToolCallback = pathway.toolCallback;
        this.toolCallsBuffer = [];
        this.contentBuffer = ''; // Initialize content buffer
    }
    
    async tryParseMessages(messages) {
        // Whitelist of content types we accept from parsed JSON strings
        // Only these types will be used if a JSON string parses to an object
        const WHITELISTED_CONTENT_TYPES = ['text', 'image', 'image_url'];
        
        // Helper to check if an object is a valid whitelisted content type
        const isValidContentObject = (obj) => {
            return (
                typeof obj === 'object' && 
                obj !== null && 
                typeof obj.type === 'string' &&
                WHITELISTED_CONTENT_TYPES.includes(obj.type)
            );
        };
        
        return await Promise.all(messages.map(async message => {
            try {
                // Parse tool_calls from string array to object array if present
                const parsedMessage = { ...message };
                if (message.tool_calls && Array.isArray(message.tool_calls)) {
                    parsedMessage.tool_calls = message.tool_calls.map(tc => {
                        if (typeof tc === 'string') {
                            try {
                                return JSON.parse(tc);
                            } catch (e) {
                                logger.warn(`Failed to parse tool_call: ${tc}`);
                                return tc;
                            }
                        }
                        return tc;
                    });
                }
                
                // Process content arrays through normal handling
                // Note: Even assistant messages with tool_calls need their content arrays validated
                if (Array.isArray(message.content)) {
                    parsedMessage.content = await Promise.all(message.content.map(async item => {
                        // A content array item can be a plain string, a JSON string, or a valid content object
                        let itemToProcess, contentType;

                        // First try to parse it as a JSON string
                        const parsedItem = safeJsonParse(item);
                        
                        // Check if parsed item is a known content object
                        if (isValidContentObject(parsedItem)) {
                            itemToProcess = parsedItem;
                            contentType = parsedItem.type;
                        } 
                        // It's not, so check if original item is already a known content object
                        else if (isValidContentObject(item)) {
                            itemToProcess = item;
                            contentType = item.type;
                        } 
                        // It's not, so return it as a text object. This covers all unknown objects and strings.
                        else {
                            const textContent = typeof item === 'string' ? item : JSON.stringify(item);
                            return { type: 'text', text: textContent };
                        }
                        
                        // Process whitelisted content types (we know contentType is known and valid at this point)
                        if (contentType === 'text') {
                            return { type: 'text', text: itemToProcess.text || '' };
                        }
                        
                        if (contentType === 'image' || contentType === 'image_url') {
                            const url = itemToProcess.url || itemToProcess.image_url?.url;
                            if (url && await this.validateImageUrl(url)) {
                                return { type: 'image_url', image_url: { url } };
                            }
                        }

                        // If we got here, we failed to process something - likely the image - so we'll return it as a text object.
                        const textContent = typeof itemToProcess === 'string' 
                            ? itemToProcess 
                            : JSON.stringify(itemToProcess);
                        return { type: 'text', text: textContent };
                    }));
                }
                
                // For assistant messages with tool_calls, content can be null or string (not array)
                // If it's an array, it was already processed above
                if (message.role === "assistant" && parsedMessage.tool_calls) {
                    return parsedMessage;
                }
                
                // For tool messages, validate and convert content to ensure compliance
                // Tool messages can only have: string or array of text content parts
                if (message.role === "tool") {
                    // If content is already a string, keep it as-is
                    if (typeof parsedMessage.content === 'string') {
                        return parsedMessage;
                    }
                    
                    // If content is null/undefined, convert to empty string
                    if (parsedMessage.content == null) {
                        parsedMessage.content = '';
                        return parsedMessage;
                    }
                    
                    // If content is an array, ensure all items are text content parts
                    if (Array.isArray(parsedMessage.content)) {
                        parsedMessage.content = parsedMessage.content.map(item => {
                            // If already a text content part, keep it
                            if (typeof item === 'object' && item !== null && 
                                item.type === 'text' && typeof item.text === 'string') {
                                return item;
                            }
                            
                            // Convert anything else to a text content part
                            if (typeof item === 'string') {
                                return { type: 'text', text: item };
                            }
                            if (typeof item === 'object' && item !== null && item.text) {
                                return { type: 'text', text: String(item.text) };
                            }
                            return { type: 'text', text: JSON.stringify(item) };
                        });
                    }
                }
                
                return parsedMessage;
            } catch (e) {
                return message;
            }
        }));
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
                let content;
                if (message.content === undefined) {
                    content = JSON.stringify(sanitizeBase64(message));
                } else if (Array.isArray(message.content)) {
                    // Only stringify objects, not strings (which may already be JSON strings)
                    content = message.content.map(item => {
                        const sanitized = sanitizeBase64(item);
                        return typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
                    }).join(', ');
                } else {
                    content = message.content;
                }
                const { length, units } = this.getLength(content);
                const displayContent = this.shortenContent(content);

                let logMessage = `message ${index + 1}: role: ${message.role}, ${units}: ${length}, content: "${displayContent}"`;
                
                // Add tool calls to log if they exist
                if (message.role === 'assistant' && message.tool_calls) {
                    logMessage += `, tool_calls: ${JSON.stringify(message.tool_calls)}`;
                }
                
                logger.verbose(logMessage);
                totalLength += length;
                totalUnits = units;
            });
            logger.info(`[chat request contained ${totalLength} ${totalUnits}]`);
        } else {
            const message = messages[0];
            let content;
            if (Array.isArray(message.content)) {
                // Only stringify objects, not strings (which may already be JSON strings)
                content = message.content.map(item => {
                    const sanitized = sanitizeBase64(item);
                    return typeof sanitized === 'string' ? sanitized : JSON.stringify(sanitized);
                }).join(', ');
            } else {
                content = message.content;
            }
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


    async getRequestParameters(text, parameters, prompt) {
        const requestParameters = super.getRequestParameters(text, parameters, prompt);

        requestParameters.messages = await this.tryParseMessages(requestParameters.messages);

        const modelMaxReturnTokens = this.getModelMaxReturnTokens();
        const maxTokensPrompt = this.promptParameters.max_tokens;
        const maxTokensModel = this.getModelMaxTokenLength() * (1 - this.getPromptTokenRatio());

        const maxTokens = maxTokensPrompt || maxTokensModel;

        requestParameters.max_tokens = maxTokens ? Math.min(maxTokens, modelMaxReturnTokens) : modelMaxReturnTokens;

        this.promptParameters.responseFormat && (requestParameters.response_format = this.promptParameters.responseFormat);

        return requestParameters;
    }

    async execute(text, parameters, prompt, cortexRequest) {
        const requestParameters = await this.getRequestParameters(text, parameters, prompt);
        const { stream } = parameters;

        cortexRequest.data = {
            ...(cortexRequest.data || {}),
            ...requestParameters,
        };
        cortexRequest.params = {};
        cortexRequest.stream = stream;

        return this.executeRequest(cortexRequest);
    }

    // Override parseResponse to handle tool calls
    parseResponse(data) {
        if (!data) return "";
        const { choices } = data;
        if (!choices || !choices.length) {
            return data;
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

    processStreamEvent(event, requestProgress) {
        // check for end of stream or in-stream errors
        if (event.data.trim() === '[DONE]') {
            requestProgress.progress = 1;
            // Clear buffers when stream is done
            this.toolCallsBuffer = [];
            this.contentBuffer = ''; // Clear content buffer
        } else {
            let parsedMessage;
            try {
                parsedMessage = JSON.parse(event.data);
            } catch (error) {
                // Clear buffers on error
                this.toolCallsBuffer = [];
                this.contentBuffer = '';
                throw new Error(`Could not parse stream data: ${error}`);
            }

            // error can be in different places in the message
            const streamError = parsedMessage?.error || parsedMessage?.choices?.[0]?.delta?.content?.error || parsedMessage?.choices?.[0]?.text?.error;
            if (streamError) {
                // Clear buffers on error
                this.toolCallsBuffer = [];
                this.contentBuffer = '';
                throw new Error(streamError);
            }

            const delta = parsedMessage?.choices?.[0]?.delta;
            
            // Check if this is an empty/idle event that we should skip
            const isEmptyEvent = !delta || 
                (Object.keys(delta).length === 0) || 
                (Object.keys(delta).length === 1 && delta.content === '') ||
                (Object.keys(delta).length === 1 && delta.tool_calls && delta.tool_calls.length === 0);
            
            // Skip publishing empty events unless they have a finish_reason
            const hasFinishReason = parsedMessage?.choices?.[0]?.finish_reason;
            
            if (isEmptyEvent && !hasFinishReason) {
                // Return requestProgress without setting data to prevent publishing
                return requestProgress;
            }
            
            // Set the data for non-empty events or events with finish_reason
            requestProgress.data = event.data;

            // Accumulate content
            if (delta?.content) {
                this.contentBuffer += delta.content;
            }

            // Handle tool calls in streaming response
            if (delta?.tool_calls) {
                // Accumulate tool call deltas into the buffer
                delta.tool_calls.forEach((toolCall) => {
                    const index = toolCall.index;
                    if (!this.toolCallsBuffer[index]) {
                        this.toolCallsBuffer[index] = {
                            id: toolCall.id || '',
                            type: toolCall.type || 'function',
                            function: {
                                name: toolCall.function?.name || '',
                                arguments: toolCall.function?.arguments || ''
                            }
                        };
                    } else {
                        if (toolCall.function?.name) {
                            this.toolCallsBuffer[index].function.name += toolCall.function.name;
                        }
                        if (toolCall.function?.arguments) {
                            this.toolCallsBuffer[index].function.arguments += toolCall.function.arguments;
                        }
                    }
                });
            }

            // finish reason can be in different places in the message
            const finishReason = parsedMessage?.choices?.[0]?.finish_reason || parsedMessage?.candidates?.[0]?.finishReason;
            if (finishReason) {
                const pathwayResolver = requestState[this.requestId]?.pathwayResolver; // Get resolver

                switch (finishReason.toLowerCase()) {
                    case 'tool_calls':
                        // Process complete tool calls when we get the finish reason
                        if (this.pathwayToolCallback && this.toolCallsBuffer.length > 0 && pathwayResolver) {
                            // Filter out undefined elements from the tool calls buffer
                            const validToolCalls = this.toolCallsBuffer.filter(tc => tc && tc.function && tc.function.name);
                            const toolMessage = {
                                role: 'assistant',
                                content: delta?.content || '', 
                                tool_calls: validToolCalls,
                            };
                            this.pathwayToolCallback(pathwayResolver?.args, toolMessage, pathwayResolver);
                        }
                        // Don't set progress to 1 for tool calls to keep stream open
                        // Clear tool buffer after processing, but keep content buffer
                        this.toolCallsBuffer = []; 
                        break;
                    case 'safety':
                        const safetyRatings = JSON.stringify(parsedMessage?.candidates?.[0]?.safetyRatings) || '';
                        logger.warn(`Request ${this.requestId} was blocked by the safety filter. ${safetyRatings}`);
                        requestProgress.data = `\n\nResponse blocked by safety filter: ${safetyRatings}`;
                        requestProgress.progress = 1;
                        // Clear buffers on finish
                        this.toolCallsBuffer = [];
                        this.contentBuffer = '';
                        break;
                    default: // Includes 'stop' and other normal finish reasons
                        // Look to see if we need to add citations to the response
                        addCitationsToResolver(pathwayResolver, this.contentBuffer);
                        requestProgress.progress = 1;
                        // Clear buffers on finish
                        this.toolCallsBuffer = [];
                        this.contentBuffer = '';
                        break;
                }
            }
        }
        return requestProgress;
    }

}

export default OpenAIVisionPlugin;
