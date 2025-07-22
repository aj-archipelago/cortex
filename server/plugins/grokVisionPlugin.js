import OpenAIVisionPlugin from './openAiVisionPlugin.js';
import logger from '../../lib/logger.js';

class GrokVisionPlugin extends OpenAIVisionPlugin {

    constructor(pathway, model) {
        super(pathway, model);
        // Grok is always multimodal, so we inherit all vision capabilities from OpenAIVisionPlugin
    }

    // Override the logging function to display Grok-specific messages
    logRequestData(data, responseData, prompt) {
        const { stream, messages } = data;
        if (messages && messages.length > 1) {
            logger.info(`[grok vision request sent containing ${messages.length} messages]`);
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
            logger.info(`[grok vision request contained ${totalLength} ${totalUnits}]`);
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
            logger.info(`[grok vision request sent containing ${length} ${units}]`);
            logger.verbose(`${this.shortenContent(content)}`);
        }
        if (stream) {
            logger.info(`[grok vision response received as an SSE stream]`);
        } else {
            const parsedResponse = this.parseResponse(responseData);
            
            if (typeof parsedResponse === 'string') {
                const { length, units } = this.getLength(parsedResponse);
                logger.info(`[grok vision response received containing ${length} ${units}]`);
                logger.verbose(`${this.shortenContent(parsedResponse)}`);
            } else {
                logger.info(`[grok vision response received containing object]`);
                logger.verbose(`${JSON.stringify(parsedResponse)}`);
            }
        }

        prompt && prompt.debugInfo && (prompt.debugInfo += `\n${JSON.stringify(data)}`);
    }

    async getRequestParameters(text, parameters, prompt) {
        const requestParameters = await super.getRequestParameters(text, parameters, prompt);

        // Add Grok-specific parameters
        if (parameters.web_search !== undefined) {
            requestParameters.web_search = parameters.web_search;
        }

        if (parameters.real_time_data !== undefined) {
            requestParameters.real_time_data = parameters.real_time_data;
        }

        if (parameters.citations !== undefined) {
            requestParameters.citations = parameters.citations;
        }

        if (parameters.search_queries_only !== undefined) {
            requestParameters.search_queries_only = parameters.search_queries_only;
        }

        if (parameters.search_grounding !== undefined) {
            requestParameters.search_grounding = parameters.search_grounding;
        }

        if (parameters.vision !== undefined) {
            requestParameters.vision = parameters.vision;
        }

        if (parameters.vision_detail !== undefined) {
            requestParameters.vision_detail = parameters.vision_detail;
        }

        if (parameters.vision_auto !== undefined) {
            requestParameters.vision_auto = parameters.vision_auto;
        }

        return requestParameters;
    }

    // Override parseResponse to handle Grok-specific response fields
    parseResponse(data) {
        const baseResponse = super.parseResponse(data);
        
        // If the base response is a string, return it as is
        if (typeof baseResponse === 'string') {
            return baseResponse;
        }

        // If it's an object (tool calls or Grok-specific response), enhance it
        if (typeof baseResponse === 'object' && baseResponse !== null) {
            const response = { ...baseResponse };

            // Add Grok-specific fields if they exist in the original data
            if (data?.choices?.[0]?.message) {
                const message = data.choices[0].message;
                
                if (message.citations) {
                    response.citations = message.citations;
                }

                if (message.search_queries) {
                    response.search_queries = message.search_queries;
                }

                if (message.web_search_results) {
                    response.web_search_results = message.web_search_results;
                }

                if (message.real_time_data) {
                    response.real_time_data = message.real_time_data;
                }
            }

            return response;
        }

        return baseResponse;
    }

    processStreamEvent(event, requestProgress) {
        // First, let the parent handle the basic streaming logic
        const processedProgress = super.processStreamEvent(event, requestProgress);
        
        // Then add Grok-specific streaming field handling
        if (event.data.trim() !== '[DONE]') {
            try {
                const parsedMessage = JSON.parse(event.data);
                const delta = parsedMessage?.choices?.[0]?.delta;

                // Handle Grok-specific streaming fields
                if (delta?.citations) {
                    processedProgress.citations = delta.citations;
                }

                if (delta?.search_queries) {
                    processedProgress.search_queries = delta.search_queries;
                }

                if (delta?.web_search_results) {
                    processedProgress.web_search_results = delta.web_search_results;
                }

                if (delta?.real_time_data) {
                    processedProgress.real_time_data = delta.real_time_data;
                }
            } catch (error) {
                // Error handling is already done in parent class
            }
        }

        return processedProgress;
    }

}

export default GrokVisionPlugin; 