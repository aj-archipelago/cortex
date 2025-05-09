import OpenAIChatPlugin from './openAiChatPlugin.js';
import logger from '../../lib/logger.js';
import { requestState } from '../requestState.js';
import { addCitationsToResolver } from '../../lib/pathwayTools.js';
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
        return await Promise.all(messages.map(async message => {
            try {
                // Handle tool-related message types
                if (message.role === "tool" || (message.role === "assistant" && message.tool_calls)) {
                    return {
                        ...message
                    };
                }

                if (Array.isArray(message.content)) {
                    return {
                        ...message,
                        content: await Promise.all(message.content.map(async item => {
                            const parsedItem = safeJsonParse(item);

                            if (typeof parsedItem === 'string') {
                                return { type: 'text', text: parsedItem };
                            }

                            if (typeof parsedItem === 'object' && parsedItem !== null) {
                                // Handle both 'image' and 'image_url' types
                                if (parsedItem.type === 'image' || parsedItem.type === 'image_url') {
                                    const url = parsedItem.url || parsedItem.image_url?.url;
                                    if (url && await this.validateImageUrl(url)) {
                                        return { type: 'image_url', image_url: { url } };
                                    }
                                    return { type: 'text', text: typeof item === 'string' ? item : JSON.stringify(item) };
                                }
                            }
                            
                            return parsedItem;
                        }))
                    };
                }
            } catch (e) {
                return message;
            }
            return message;
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
                const content = message.content === undefined ? JSON.stringify(message) : (Array.isArray(message.content) ? message.content.map(item => {
                    if (item.type === 'image_url' && item.image_url?.url?.startsWith('data:')) {
                        return JSON.stringify({
                            type: 'image_url',
                            image_url: { url: '* base64 data truncated for log *' }
                        });
                    }
                    return JSON.stringify(item);
                }).join(', ') : message.content);
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
            const content = Array.isArray(message.content) ? message.content.map(item => {
                if (item.type === 'image_url' && item.image_url?.url?.startsWith('data:')) {
                    return JSON.stringify({
                        type: 'image_url',
                        image_url: { url: '* base64 data truncated for log *' }
                    });
                }
                return JSON.stringify(item);
            }).join(', ') : message.content;
            const { length, units } = this.getLength(content);
            logger.info(`[request sent containing ${length} ${units}]`);
            logger.verbose(`${this.shortenContent(content)}`);
        }
        if (stream) {
            logger.info(`[response received as an SSE stream]`);
        } else {
            const parsedResponse = this.parseResponse(responseData);
            
            if (typeof parsedResponse === 'string') {
                const { length, units } = this.getLength(parsedResponse);
                logger.info(`[response received containing ${length} ${units}]`);
                logger.verbose(`${this.shortenContent(parsedResponse)}`);
            } else {
                logger.info(`[response received containing object]`);
                logger.verbose(`${JSON.stringify(parsedResponse)}`);
            }
        }

        prompt && prompt.debugInfo && (prompt.debugInfo += `\n${JSON.stringify(data)}`);
    }


    async getRequestParameters(text, parameters, prompt) {
        const requestParameters = super.getRequestParameters(text, parameters, prompt);

        requestParameters.messages = await this.tryParseMessages(requestParameters.messages);

        // Add tools support if provided in parameters
        if (parameters.tools) {
            requestParameters.tools = parameters.tools;
        }

        if (parameters.tool_choice) {
            requestParameters.tool_choice = parameters.tool_choice;
        }

        const modelMaxReturnTokens = this.getModelMaxReturnTokens();
        const maxTokensPrompt = this.promptParameters.max_tokens;
        const maxTokensModel = this.getModelMaxTokenLength() * (1 - this.getPromptTokenRatio());

        const maxTokens = maxTokensPrompt || maxTokensModel;

        requestParameters.max_tokens = maxTokens ? Math.min(maxTokens, modelMaxReturnTokens) : modelMaxReturnTokens;

        if (this.promptParameters.json) {
            //requestParameters.response_format = { type: "json_object", }
        }

        return requestParameters;
    }

    async execute(text, parameters, prompt, cortexRequest) {
        const requestParameters = await this.getRequestParameters(text, parameters, prompt);
        const { stream } = parameters;

        cortexRequest.data = {
            ...(cortexRequest.data || {}),
            ...requestParameters,
        };
        cortexRequest.params = {}; // query params
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

        // if we got a choices array back with more than one choice, return the whole array
        if (choices.length > 1) {
            return choices;
        }

        const choice = choices[0];
        const message = choice.message;

        // Handle tool calls in the response
        if (message.tool_calls) {
            return {
                role: message.role,
                content: message.content || "",
                tool_calls: message.tool_calls
            };
        }

        return message.content || "";
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
                requestProgress.data = event.data;
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
                            const toolMessage = {
                                role: 'assistant',
                                content: delta?.content || '', 
                                tool_calls: this.toolCallsBuffer,
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
