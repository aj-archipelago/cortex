import OpenAIVisionPlugin from './openAiVisionPlugin.js';
import logger from '../../lib/logger.js';
import { getSearchResultId } from '../../lib/util.js';

function safeJsonParse(content) {
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

        // Add Grok-specific search parameters using the correct X.AI API structure
        if (parameters.search_mode !== undefined || parameters.web_search !== undefined || parameters.real_time_data !== undefined || 
            parameters.return_citations !== undefined || parameters.from_date !== undefined || parameters.to_date !== undefined || 
            parameters.max_search_results !== undefined || parameters.sources !== undefined) {
            
            // Determine search mode based on parameters
            let searchMode = 'off';
            
            if (parameters.search_mode) {
                searchMode = parameters.search_mode; // 'off', 'auto', or 'on'
            } else if (parameters.web_search === true || parameters.real_time_data === true) {
                searchMode = 'auto'; // Enable search if any search-related parameter is true
            } else if (parameters.web_search === false && parameters.real_time_data === false) {
                searchMode = 'off'; // Explicitly disable search
            }
            
            // Build search_parameters object
            const searchParameters = {
                mode: searchMode
            };

            // Add return_citations (defaults to true)
            if (parameters.return_citations !== undefined) {
                searchParameters.return_citations = parameters.return_citations;
            }

            // Add date range parameters
            if (parameters.from_date !== undefined) {
                searchParameters.from_date = parameters.from_date;
            }

            if (parameters.to_date !== undefined) {
                searchParameters.to_date = parameters.to_date;
            }

            // Add max_search_results (defaults to 20)
            if (parameters.max_search_results !== undefined) {
                searchParameters.max_search_results = parameters.max_search_results;
            }

            // Add sources configuration
            if (parameters.sources !== undefined) {
                // Convert string sources to objects with type property
                if (Array.isArray(parameters.sources)) {
                    searchParameters.sources = parameters.sources.map(source => {
                        if (typeof source === 'string') {
                            return { type: source };
                        }
                        return source;
                    });
                } else {
                    searchParameters.sources = parameters.sources;
                }
            }

            requestParameters.search_parameters = searchParameters;
            
            // Debug: Log the search parameters being sent
            logger.info(`Grok search_parameters being sent: ${JSON.stringify(searchParameters)}`);
        } else {
            logger.info('No search parameters found in request');
        }

        // Note: Vision parameters are handled in the message content structure
        // The 'detail' field is part of the image_url object in messages, not a top-level parameter
        // Vision functionality is automatically enabled when images are present in the message content

        return requestParameters;
    }

    // Override execute to add Live Search data to tool field
    async execute(text, parameters, prompt, cortexRequest) {
        const result = await super.execute(text, parameters, prompt, cortexRequest);
        
        // Debug: Log the result to see what we're getting
        logger.info(`Grok execute result type: ${typeof result}`);
        
        // Check if we have stored Live Search data from parseResponse
        if (this.liveSearchData) {
            logger.info('Found stored Live Search data, adding to tool field');
            
            // Get the pathway resolver from the cortexRequest
            const pathwayResolver = cortexRequest?.pathwayResolver;
            if (pathwayResolver) {
                this.addLiveSearchDataToTool(pathwayResolver, this.liveSearchData);
                // Clear the stored data after using it
                this.liveSearchData = null;
            } else {
                logger.warn('No pathway resolver found in cortexRequest');
            }
        } else {
            logger.info('No Live Search data found in result');
        }
        
        return result;
    }

    // Override processStreamEvent to handle Grok streaming format
    processStreamEvent(event, requestProgress) {
        // First, let the parent handle the basic streaming logic
        const processedProgress = super.processStreamEvent(event, requestProgress);
        
        // Then add Grok-specific streaming field handling
        if (event.data.trim() !== '[DONE]') {
            try {
                const parsedMessage = JSON.parse(event.data);
                const delta = parsedMessage?.choices?.[0]?.delta;
                
                // Check for Grok-specific fields in streaming response
                if (parsedMessage?.citations || parsedMessage?.search_queries || 
                    parsedMessage?.web_search_results || parsedMessage?.real_time_data) {
                    
                    logger.info('Grok streaming: Found Live Search data in stream');
                    
                    // Store Live Search data for later use
                    if (!this.liveSearchData) {
                        this.liveSearchData = {};
                    }
                    
                    if (parsedMessage.citations) {
                        this.liveSearchData.citations = parsedMessage.citations;
                    }
                    
                    if (parsedMessage.search_queries) {
                        this.liveSearchData.search_queries = parsedMessage.search_queries;
                    }
                    
                    if (parsedMessage.web_search_results) {
                        this.liveSearchData.web_search_results = parsedMessage.web_search_results;
                    }
                    
                    if (parsedMessage.real_time_data) {
                        this.liveSearchData.real_time_data = parsedMessage.real_time_data;
                    }
                    
                    if (parsedMessage.usage) {
                        this.liveSearchData.usage = parsedMessage.usage;
                    }
                }
                
                // Check for Grok-specific fields in the delta (for incremental updates)
                if (delta?.citations || delta?.search_queries || 
                    delta?.web_search_results || delta?.real_time_data) {
                    
                    logger.info('Grok streaming: Found Live Search data in delta');
                    
                    // Store Live Search data for later use
                    if (!this.liveSearchData) {
                        this.liveSearchData = {};
                    }
                    
                    if (delta.citations) {
                        this.liveSearchData.citations = delta.citations;
                    }
                    
                    if (delta.search_queries) {
                        this.liveSearchData.search_queries = delta.search_queries;
                    }
                    
                    if (delta.web_search_results) {
                        this.liveSearchData.web_search_results = delta.web_search_results;
                    }
                    
                    if (delta.real_time_data) {
                        this.liveSearchData.real_time_data = delta.real_time_data;
                    }
                }
                
            } catch (error) {
                logger.warn(`Error parsing Grok stream event: ${error.message}`);
            }
        }
        
        return processedProgress;
    }

    // Override tryParseMessages to preserve X.AI vision detail field
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
                                    const detail = parsedItem.image_url?.detail || parsedItem.detail;
                                    if (url && await this.validateImageUrl(url)) {
                                        const imageUrl = { url };
                                        if (detail) {
                                            imageUrl.detail = detail;
                                        }
                                        return { type: 'image_url', image_url: imageUrl };
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

        // Handle tool calls in the response
        if (message.tool_calls) {
            return {
                role: message.role,
                content: message.content || "",
                tool_calls: message.tool_calls
            };
        }

        // Check for Grok-specific fields in the message (for non-streaming responses)
        if (message.citations || message.search_queries || 
            message.web_search_results || message.real_time_data) {
            
            logger.info('Grok-specific fields found in message, returning object with Live Search data');
            const response = {
                role: message.role,
                content: message.content || ""
            };
            
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

            return response;
        }
        
        // Check for Grok-specific fields at the top level (for non-streaming responses)
        const hasTopLevelGrokFields = data?.citations || data?.search_queries || 
                                     data?.web_search_results || data?.real_time_data;
        
        if (hasTopLevelGrokFields) {
            logger.info('Grok-specific fields found at top level, storing Live Search data for tool field');
            
            // Store the Live Search data for later use in the tool field
            this.liveSearchData = {
                role: message.role || 'assistant',
                content: message.content || ""
            };
            
            if (data.citations) {
                // Transform citations from URLs to objects with title, url, and searchResultId
                this.liveSearchData.citations = data.citations.map(url => {
                    let title = 'Citation';
                    
                    try {
                        const urlObj = new URL(url);
                        const pathname = urlObj.pathname;
                        const pathParts = pathname.replace(/^\/+|\/+$/g, '').split('/');
                        
                        if (pathParts.length > 0) {
                            let lastPart = pathParts[pathParts.length - 1];
                            lastPart = lastPart.replace(/\.(html|htm|php|asp|aspx|jsp)$/i, '');
                            
                            if (url.includes('x.com/') || url.includes('twitter.com/')) {
                                const match = url.match(/status\/(\d+)/);
                                if (match) {
                                    title = `X Post ${match[1]}`;
                                } else {
                                    title = 'X Post';
                                }
                            } else if (url.includes('github.io/')) {
                                const hostname = urlObj.hostname;
                                if (hostname.includes('.')) {
                                    title = hostname.split('.')[0];
                                } else {
                                    title = hostname;
                                }
                            } else if (lastPart && lastPart.length > 3) {
                                title = lastPart
                                    .replace(/-/g, ' ')
                                    .replace(/_/g, ' ')
                                    .replace(/\b\w/g, l => l.toUpperCase());
                            } else if (pathParts.length > 1) {
                                let secondLastPart = pathParts[pathParts.length - 2];
                                if (secondLastPart && secondLastPart.length > 3) {
                                    title = secondLastPart
                                        .replace(/-/g, ' ')
                                        .replace(/_/g, ' ')
                                        .replace(/\b\w/g, l => l.toUpperCase());
                                }
                            }
                        }
                        
                        if (title === 'Citation' || title.length < 3) {
                            const hostname = urlObj.hostname;
                            if (hostname && hostname !== 'localhost') {
                                title = hostname.replace(/^www\./, '');
                            }
                        }
                    } catch (error) {
                        const lastPart = url.split('/').pop();
                        if (lastPart && lastPart.length > 3) {
                            title = lastPart.replace(/-/g, ' ').replace(/_/g, ' ');
                        }
                    }
                    
                    return {
                        searchResultId: getSearchResultId(),
                        title: title,
                        url: url
                    };
                });
                logger.info(`Top level citations found: ${data.citations.length}`);
            }

            if (data.search_queries) {
                this.liveSearchData.search_queries = data.search_queries;
            }

            if (data.web_search_results) {
                this.liveSearchData.web_search_results = data.web_search_results;
            }

            if (data.real_time_data) {
                this.liveSearchData.real_time_data = data.real_time_data;
            }

            if (data.usage) {
                this.liveSearchData.usage = data.usage;
            }

            // For non-streaming responses, return content immediately
            // Live Search data will be added to tool field via execute method
            return message.content || "";
        }

        return message.content || "";
    }

    // Method to add Live Search data to the pathway resolver tool field
    addLiveSearchDataToTool(pathwayResolver, parsedResponse) {
        if (parsedResponse && (parsedResponse.citations || parsedResponse.search_queries || 
                              parsedResponse.web_search_results || parsedResponse.real_time_data)) {
            
            const toolObj = typeof pathwayResolver.tool === 'string' ? 
                JSON.parse(pathwayResolver.tool || '{}') : 
                (pathwayResolver.tool || {});
            
            // Add Live Search data to tool object
            if (parsedResponse.citations) {
                toolObj.citations = parsedResponse.citations;
            }
            
            if (parsedResponse.search_queries) {
                toolObj.search_queries = parsedResponse.search_queries;
            }
            
            if (parsedResponse.web_search_results) {
                toolObj.web_search_results = parsedResponse.web_search_results;
            }
            
            if (parsedResponse.real_time_data) {
                toolObj.real_time_data = parsedResponse.real_time_data;
            }
            
            // Add usage data if available
            if (parsedResponse.usage) {
                toolObj.usage = parsedResponse.usage;
            }
            
            pathwayResolver.tool = JSON.stringify(toolObj);
        }
    }

    processStreamEvent(event, requestProgress) {
        // First, let the parent handle the basic streaming logic
        const processedProgress = super.processStreamEvent(event, requestProgress);
        
        // Then add Grok-specific streaming field handling
        if (event.data.trim() !== '[DONE]') {
            try {
                const parsedMessage = JSON.parse(event.data);
                const delta = parsedMessage?.choices?.[0]?.delta;
                
                // Check for Grok-specific fields in streaming response
                if (parsedMessage?.citations || parsedMessage?.search_queries || 
                    parsedMessage?.web_search_results || parsedMessage?.real_time_data) {
                    
                    logger.info('Grok streaming: Found Live Search data in stream event');
                    
                    // Store Live Search data for later use
                    if (!this.liveSearchData) {
                        this.liveSearchData = {};
                    }
                    
                    if (parsedMessage.citations) {
                        // Transform citations from URLs to objects with title, url, and searchResultId
                        this.liveSearchData.citations = parsedMessage.citations.map(url => {
                            let title = 'Citation';
                            
                            try {
                                const urlObj = new URL(url);
                                const pathname = urlObj.pathname;
                                const pathParts = pathname.replace(/^\/+|\/+$/g, '').split('/');
                                
                                if (pathParts.length > 0) {
                                    let lastPart = pathParts[pathParts.length - 1];
                                    lastPart = lastPart.replace(/\.(html|htm|php|asp|aspx|jsp)$/i, '');
                                    
                                    if (url.includes('x.com/') || url.includes('twitter.com/')) {
                                        const match = url.match(/status\/(\d+)/);
                                        if (match) {
                                            title = `X Post ${match[1]}`;
                                        } else {
                                            title = 'X Post';
                                        }
                                    } else if (url.includes('github.io/')) {
                                        const hostname = urlObj.hostname;
                                        if (hostname.includes('.')) {
                                            title = hostname.split('.')[0];
                                        } else {
                                            title = hostname;
                                        }
                                    } else if (lastPart && lastPart.length > 3) {
                                        title = lastPart
                                            .replace(/-/g, ' ')
                                            .replace(/_/g, ' ')
                                            .replace(/\b\w/g, l => l.toUpperCase());
                                    } else if (pathParts.length > 1) {
                                        let secondLastPart = pathParts[pathParts.length - 2];
                                        if (secondLastPart && secondLastPart.length > 3) {
                                            title = secondLastPart
                                                .replace(/-/g, ' ')
                                                .replace(/_/g, ' ')
                                                .replace(/\b\w/g, l => l.toUpperCase());
                                        }
                                    }
                                }
                                
                                if (title === 'Citation' || title.length < 3) {
                                    const hostname = urlObj.hostname;
                                    if (hostname && hostname !== 'localhost') {
                                        title = hostname.replace(/^www\./, '');
                                    }
                                }
                            } catch (error) {
                                const lastPart = url.split('/').pop();
                                if (lastPart && lastPart.length > 3) {
                                    title = lastPart.replace(/-/g, ' ').replace(/_/g, ' ');
                                }
                            }
                            
                            return {
                                searchResultId: getSearchResultId(),
                                title: title,
                                url: url
                            };
                        });
                        
                        // Also add to processedProgress for test compatibility
                        processedProgress.citations = this.liveSearchData.citations;
                    }
                    
                    if (parsedMessage.search_queries) {
                        this.liveSearchData.search_queries = parsedMessage.search_queries;
                        processedProgress.search_queries = parsedMessage.search_queries;
                    }
                    
                    if (parsedMessage.web_search_results) {
                        this.liveSearchData.web_search_results = parsedMessage.web_search_results;
                        processedProgress.web_search_results = parsedMessage.web_search_results;
                    }
                    
                    if (parsedMessage.real_time_data) {
                        this.liveSearchData.real_time_data = parsedMessage.real_time_data;
                        processedProgress.real_time_data = parsedMessage.real_time_data;
                    }
                    
                    if (parsedMessage.usage) {
                        this.liveSearchData.usage = parsedMessage.usage;
                    }
                }
                
                // Check for Grok-specific fields in the delta (for incremental updates)
                if (delta?.citations || delta?.search_queries || 
                    delta?.web_search_results || delta?.real_time_data) {
                    
                    logger.info('Grok streaming: Found Live Search data in delta');
                    
                    // Store Live Search data for later use
                    if (!this.liveSearchData) {
                        this.liveSearchData = {};
                    }
                    
                    if (delta.citations) {
                        this.liveSearchData.citations = delta.citations;
                        processedProgress.citations = delta.citations;
                    }
                    
                    if (delta.search_queries) {
                        this.liveSearchData.search_queries = delta.search_queries;
                        processedProgress.search_queries = delta.search_queries;
                    }
                    
                    if (delta.web_search_results) {
                        this.liveSearchData.web_search_results = delta.web_search_results;
                        processedProgress.web_search_results = delta.web_search_results;
                    }
                    
                    if (delta.real_time_data) {
                        this.liveSearchData.real_time_data = delta.real_time_data;
                        processedProgress.real_time_data = delta.real_time_data;
                    }
                }
                
            } catch (error) {
                logger.warn(`Error parsing Grok stream event: ${error.message}`);
            }
        }
        
        return processedProgress;
    }

}

export default GrokVisionPlugin; 