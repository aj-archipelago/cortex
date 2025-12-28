// OpenAIChatPlugin.js
import ModelPlugin from './modelPlugin.js';
import logger from '../../lib/logger.js';
import CortexResponse from '../../lib/cortexResponse.js';
import { encoding_for_model } from '@dqbd/tiktoken';

class OpenAIChatPlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
    }

    /**
     * Normalizes OpenAI usage format to standard format.
     * OpenAI format: { prompt_tokens, completion_tokens, total_tokens }
     */
    normalizeUsage(usage) {
        if (!usage) return null;

        // OpenAI format: { prompt_tokens, completion_tokens, total_tokens }
        if (usage.prompt_tokens !== undefined) {
            return {
                promptTokens: usage.prompt_tokens,
                completionTokens: usage.completion_tokens || 0,
                totalTokens: usage.total_tokens || (usage.prompt_tokens + (usage.completion_tokens || 0))
            };
        }

        // Already normalized format
        if (usage.promptTokens !== undefined) {
            return {
                promptTokens: usage.promptTokens,
                completionTokens: usage.completionTokens || 0,
                totalTokens: usage.totalTokens || (usage.promptTokens + (usage.completionTokens || 0))
            };
        }

        return null;
    }

    /**
     * Counts tokens using tiktoken library for accurate OpenAI token counting.
     * This provides accurate token counts for OpenAI models using the model-specific tokenizer.
     * 
     * @param {Array} messages - Messages in OpenAI format
     * @param {Object} cortexRequest - Request context (not used for OpenAI, but kept for interface consistency)
     * @returns {Promise<number|null>} Token count, or null if counting fails
     */
    async countTokensBeforeRequest(messages, cortexRequest = null) {
        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return 0;
        }

        try {
            // Get the model name - try modelName first, then model.name
            const modelName = this.modelName || this.model?.name || 'gpt-4o';
            
            // Get the appropriate encoder for this model
            // tiktoken will fall back to cl100k_base if model not recognized
            let encoder;
            try {
                encoder = encoding_for_model(modelName);
            } catch (error) {
                // If model not recognized, use cl100k_base (used by most OpenAI models)
                logger.debug(`Model ${modelName} not recognized by tiktoken, using cl100k_base encoder`);
                const { get_encoding } = await import('@dqbd/tiktoken');
                encoder = get_encoding('cl100k_base');
            }

            let totalTokens = 0;

            // Count tokens according to OpenAI's message format
            // See: https://github.com/openai/openai-python/blob/main/src/openai/lib/encoding.py
            for (const message of messages) {
                // Per-message overhead: <|im_start|>role\ncontent<|im_end|>\n
                // This is typically 4 tokens per message
                totalTokens += 4;

                // Count role tokens
                const role = message.role || '';
                if (role) {
                    totalTokens += encoder.encode(role).length;
                }

                // Count content tokens
                if (typeof message.content === 'string') {
                    totalTokens += encoder.encode(message.content).length;
                } else if (Array.isArray(message.content)) {
                    // Handle multimodal content
                    for (const item of message.content) {
                        if (typeof item === 'string') {
                            totalTokens += encoder.encode(item).length;
                        } else if (item.type === 'text') {
                            totalTokens += encoder.encode(item.text || '').length;
                        } else if (item.type === 'image_url') {
                            // For vision models, images are encoded differently
                            // Base64 images: ~85 tokens for 512x512, scales with resolution
                            // For now, use a reasonable estimate
                            // OpenAI's actual encoding is more complex (base64 + metadata)
                            totalTokens += 170; // Conservative estimate for high-res images
                        }
                    }
                }

                // Count tool_calls if present
                if (message.tool_calls && Array.isArray(message.tool_calls)) {
                    for (const toolCall of message.tool_calls) {
                        // Tool call overhead: function name, arguments, etc.
                        totalTokens += 4; // Base overhead
                        if (toolCall.function) {
                            if (toolCall.function.name) {
                                totalTokens += encoder.encode(toolCall.function.name).length;
                            }
                            if (toolCall.function.arguments) {
                                totalTokens += encoder.encode(toolCall.function.arguments).length;
                            }
                        }
                    }
                }
            }

            // Add final <|im_start|>assistant<|im_end|> overhead (typically 2 tokens)
            totalTokens += 2;

            return totalTokens;
        } catch (error) {
            // Log but don't throw - fallback to estimation
            logger.debug(`countTokensBeforeRequest failed for OpenAI: ${error.message}`);
            return null;
        }
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

        try {    
            tools = (tools && typeof tools === 'string' && tools !== '' ? JSON.parse(tools) : tools);
            functions = (functions && typeof functions === 'string' && functions !== '' ? JSON.parse(functions) : functions);
        } catch (e) {
            tools = [];
            functions = [];
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
        cortexRequest.params = {};

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

        // Normalize usage data to standard format (plugin handles its own format)
        const normalizedUsage = this.normalizeUsage(data.usage);

        // Create standardized CortexResponse object
        const cortexResponse = new CortexResponse({
            output_text: message.content || "",
            finishReason: choice.finish_reason || 'stop',
            usage: normalizedUsage,
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

    // Override processStreamEvent to handle OpenAI Chat streaming format
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

            // Check if this is an empty/idle event that we should skip
            const delta = parsedMessage?.choices?.[0]?.delta;
            const isEmptyEvent = !delta || 
                (Object.keys(delta).length === 0) || 
                (Object.keys(delta).length === 1 && delta.content === '') ||
                (Object.keys(delta).length === 1 && delta.tool_calls && delta.tool_calls.length === 0);
            
            // Skip publishing empty events unless they have a finish_reason
            const hasFinishReason = parsedMessage?.choices?.[0]?.finish_reason || parsedMessage?.candidates?.[0]?.finishReason;
            
            if (isEmptyEvent && !hasFinishReason) {
                // Return requestProgress without setting data to prevent publishing
                return requestProgress;
            }
            
            // Set the data for non-empty events or events with finish_reason
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
