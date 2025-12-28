import OpenAIVisionPlugin from './openAiVisionPlugin.js';
import logger from '../../lib/logger.js';
import { sanitizeBase64 } from '../../lib/util.js';
import { extractCitationTitle } from '../../lib/util.js';
import CortexResponse from '../../lib/cortexResponse.js';

export function safeJsonParse(content) {
    try {
        const parsedContent = JSON.parse(content);
        return (typeof parsedContent === 'object' && parsedContent !== null) ? parsedContent : content;
    } catch (e) {
        return content;
    }
}

class GrokVisionPlugin extends OpenAIVisionPlugin {

    constructor(pathway, model) {
        super(pathway, model);
        // Grok is always multimodal, so we inherit all vision capabilities from OpenAIVisionPlugin
    }

    // Override the logging function to display Grok-specific messages
    logRequestData(data, responseData, prompt) {
        const { stream, messages } = data;
        if (messages && messages.length > 1) {
            logger.info(`[grok request sent containing ${messages.length} messages]`);
            let totalLength = 0;
            let totalUnits;
            messages.forEach((message, index) => {
                //message.content string or array
                const content = message.content === undefined ? JSON.stringify(sanitizeBase64(message)) : (Array.isArray(message.content) ? message.content.map(item => JSON.stringify(sanitizeBase64(item))).join(', ') : message.content);
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
            logger.info(`[grok request contained ${totalLength} ${totalUnits}]`);
        } else {
            const message = messages[0];
            const content = Array.isArray(message.content) ? message.content.map(item => JSON.stringify(sanitizeBase64(item))).join(', ') : message.content;
            const { length, units } = this.getLength(content);
            logger.info(`[grok request sent containing ${length} ${units}]`);
            logger.verbose(`${this.shortenContent(content)}`);
        }
        if (stream) {
            logger.info(`[grok response received as an SSE stream]`);
        } else {
            const parsedResponse = this.parseResponse(responseData);
            
            if (typeof parsedResponse === 'string') {
                const { length, units } = this.getLength(parsedResponse);
                logger.info(`[grok response received containing ${length} ${units}]`);
                logger.verbose(`${this.shortenContent(parsedResponse)}`);
            } else {
                logger.info(`[grok response received containing object]`);
                logger.verbose(`${JSON.stringify(parsedResponse)}`);
            }
        }

        prompt && prompt.debugInfo && (prompt.debugInfo += `\n${JSON.stringify(data)}`);
    }


    // Validate live search parameters according to X.AI documentation
    validateSearchParameters(searchParams) {
        const errors = [];

        // Validate 'mode' parameter
        if (searchParams.mode !== undefined) {
            const validModes = ['off', 'auto', 'on'];
            if (!validModes.includes(searchParams.mode)) {
                errors.push(`Invalid 'mode' parameter: ${searchParams.mode}. Must be one of: ${validModes.join(', ')}`);
            }
        }

        // Validate 'sources' parameter
        if (searchParams.sources !== undefined) {
            if (!Array.isArray(searchParams.sources)) {
                errors.push("'sources' must be an array");
            } else {
                const validSourceTypes = ['web', 'news', 'x', 'rss'];
                searchParams.sources.forEach((source, index) => {
                    if (!source || typeof source !== 'object') {
                        errors.push(`Source at index ${index} must be an object`);
                        return;
                    }

                    if (!validSourceTypes.includes(source.type)) {
                        errors.push(`Invalid source type at index ${index}: ${source.type}. Must be one of: ${validSourceTypes.join(', ')}`);
                    }

                    // Validate source-specific parameters
                    if (source.type === 'web' || source.type === 'news') {
                        if (source.country !== undefined && typeof source.country !== 'string') {
                            errors.push(`Source at index ${index}: 'country' must be a string`);
                        }
                        if (source.excluded_websites !== undefined && !Array.isArray(source.excluded_websites)) {
                            errors.push(`Source at index ${index}: 'excluded_websites' must be an array`);
                        }
                        if (source.allowed_websites !== undefined && !Array.isArray(source.allowed_websites)) {
                            errors.push(`Source at index ${index}: 'allowed_websites' must be an array`);
                        }
                        if (source.safe_search !== undefined && typeof source.safe_search !== 'boolean') {
                            errors.push(`Source at index ${index}: 'safe_search' must be a boolean`);
                        }
                    }

                    if (source.type === 'x') {
                        if (source.included_x_handles !== undefined && !Array.isArray(source.included_x_handles)) {
                            errors.push(`Source at index ${index}: 'included_x_handles' must be an array`);
                        } else if (source.included_x_handles !== undefined && source.included_x_handles.length > 10) {
                            errors.push(`Source at index ${index}: 'included_x_handles' can have a maximum of 10 items`);
                        }
                        
                        if (source.excluded_x_handles !== undefined && !Array.isArray(source.excluded_x_handles)) {
                            errors.push(`Source at index ${index}: 'excluded_x_handles' must be an array`);
                        } else if (source.excluded_x_handles !== undefined && source.excluded_x_handles.length > 10) {
                            errors.push(`Source at index ${index}: 'excluded_x_handles' can have a maximum of 10 items`);
                        }
                        
                        // Check that both handles arrays are not specified simultaneously
                        if (source.included_x_handles !== undefined && source.excluded_x_handles !== undefined) {
                            errors.push(`Source at index ${index}: 'included_x_handles' and 'excluded_x_handles' cannot be specified simultaneously`);
                        }
                        
                        if (source.post_favorite_count !== undefined && typeof source.post_favorite_count !== 'number') {
                            errors.push(`Source at index ${index}: 'post_favorite_count' must be a number`);
                        }
                        if (source.post_view_count !== undefined && typeof source.post_view_count !== 'number') {
                            errors.push(`Source at index ${index}: 'post_view_count' must be a number`);
                        }
                    }

                    if (source.type === 'rss') {
                        if (source.links !== undefined && !Array.isArray(source.links)) {
                            errors.push(`Source at index ${index}: 'links' must be an array`);
                        } else if (source.links !== undefined && source.links.length > 1) {
                            errors.push(`Source at index ${index}: 'links' can only have one item`);
                        }
                    }
                });
            }
        }

        // Validate 'return_citations' parameter
        if (searchParams.return_citations !== undefined && typeof searchParams.return_citations !== 'boolean') {
            errors.push("'return_citations' must be a boolean");
        }

        // Validate date parameters
        const dateFormat = /^\d{4}-\d{2}-\d{2}$/;
        ['from_date', 'to_date'].forEach(dateField => {
            if (searchParams[dateField] !== undefined) {
                if (typeof searchParams[dateField] !== 'string') {
                    errors.push(`'${dateField}' must be a string`);
                } else if (!dateFormat.test(searchParams[dateField])) {
                    errors.push(`'${dateField}' must be in YYYY-MM-DD format`);
                } else {
                    // Validate that the date is actually valid
                    const date = new Date(searchParams[dateField]);
                    if (isNaN(date.getTime()) || date.toISOString().split('T')[0] !== searchParams[dateField]) {
                        errors.push(`'${dateField}' is not a valid date`);
                    }
                }
            }
        });

        // Validate 'max_search_results' parameter
        if (searchParams.max_search_results !== undefined) {
            if (typeof searchParams.max_search_results !== 'number' || !Number.isInteger(searchParams.max_search_results)) {
                errors.push("'max_search_results' must be an integer");
            } else if (searchParams.max_search_results <= 0) {
                errors.push("'max_search_results' must be a positive integer");
            } else if (searchParams.max_search_results > 50) {
                errors.push("'max_search_results' must be 50 or less");
            }
        }

        if (errors.length > 0) {
            throw new Error(`Live Search parameter validation failed:\n${errors.join('\n')}`);
        }

        return true;
    }

    async getRequestParameters(text, parameters, prompt) {
        const requestParameters = await super.getRequestParameters(text, parameters, prompt);

        let search_parameters = {};
        if (parameters.search_parameters) {
            try {
                search_parameters = JSON.parse(parameters.search_parameters);
            } catch (error) {
                throw new Error(`Invalid 'search_parameters' parameter: ${error.message}`);
            }
        }

        // Validate search parameters before including them
        if (Object.keys(search_parameters).length > 0) {
            this.validateSearchParameters(search_parameters);
        }

        // only set search_parameters if it's not undefined or empty
        if (Object.keys(search_parameters).length > 0) {
            requestParameters.search_parameters = search_parameters;
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

    // Override processStreamEvent to handle Grok streaming format
    processStreamEvent(event, requestProgress) {
        // First, let the parent handle the basic streaming logic
        const processedProgress = super.processStreamEvent(event, requestProgress);
        
        return processedProgress;
    }

    // Override tryParseMessages to preserve X.AI vision detail field
    async tryParseMessages(messages) {
        // First, extract detail fields from original messages before parsing
        // We need to preserve these because the parent's tryParseMessages doesn't handle them
        const detailMap = new Map();
        messages.forEach((message, index) => {
            if (Array.isArray(message.content)) {
                message.content.forEach((item, itemIndex) => {
                    const parsedItem = safeJsonParse(item);
                    const detail = parsedItem?.image_url?.detail || parsedItem?.detail || 
                                  (typeof item === 'object' && item !== null ? (item.image_url?.detail || item.detail) : null);
                    if (detail) {
                        detailMap.set(`${index}-${itemIndex}`, detail);
                    }
                });
            }
        });
        
        // Call parent's tryParseMessages to handle all the standard parsing
        const parsedMessages = await super.tryParseMessages(messages);
        
        // Now restore the detail fields to image_url objects
        return parsedMessages.map((parsedMessage, index) => {
            if (Array.isArray(parsedMessage.content)) {
                return {
                    ...parsedMessage,
                    content: parsedMessage.content.map((item, itemIndex) => {
                        // If this is an image_url item, check if we have a detail field to restore
                        if (item.type === 'image_url' && item.image_url) {
                            const detail = detailMap.get(`${index}-${itemIndex}`);
                            if (detail) {
                                return {
                                    ...item,
                                    image_url: {
                                        ...item.image_url,
                                        detail: detail
                                    }
                                };
                            }
                        }
                        return item;
                    })
                };
            }
            return parsedMessage;
        });
    }

    // Override parseResponse to handle Grok-specific response fields
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

        // Normalize usage data to standard format
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
        }

        // Handle Grok-specific Live Search data
        if (data.citations) {
            cortexResponse.citations = data.citations.map(url => ({
                title: extractCitationTitle(url),
                url: url,
                content: extractCitationTitle(url)
            }));
        }

        if (data.search_queries) {
            cortexResponse.searchQueries = data.search_queries;
        }

        if (data.web_search_results) {
            cortexResponse.searchResults = data.web_search_results;
        }

        if (data.real_time_data) {
            cortexResponse.realTimeData = data.real_time_data;
        }

        // Return the CortexResponse object
        return cortexResponse;
    }

}

export default GrokVisionPlugin; 