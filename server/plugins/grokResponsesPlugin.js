// grokResponsesPlugin.js
// Plugin for xAI's new Responses API with agentic search tools support
// This replaces the deprecated Live Search API (search_parameters approach)

import OpenAIVisionPlugin from './openAiVisionPlugin.js';
import logger from '../../lib/logger.js';
import { extractCitationTitle, sanitizeBase64 } from '../../lib/util.js';
import CortexResponse from '../../lib/cortexResponse.js';
import { requestState } from '../requestState.js';
import { addCitationsToResolver } from '../../lib/pathwayTools.js';

export function safeJsonParse(content) {
    try {
        const parsedContent = JSON.parse(content);
        return (typeof parsedContent === 'object' && parsedContent !== null) ? parsedContent : content;
    } catch (e) {
        return content;
    }
}

class GrokResponsesPlugin extends OpenAIVisionPlugin {

    constructor(pathway, model) {
        super(pathway, model);
        this.contentBuffer = '';
        this.toolCallsBuffer = [];
        this.citationsBuffer = [];
        this.inlineCitationsBuffer = [];
    }

    // Override the logging function to display Grok Responses API-specific messages
    logRequestData(data, responseData, prompt) {
        const { stream, messages, tools } = data;
        
        if (messages && messages.length > 1) {
            logger.info(`[grok responses request sent containing ${messages.length} messages]`);
            let totalLength = 0;
            let totalUnits;
            messages.forEach((message, index) => {
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
                
                if (message.role === 'assistant' && message.tool_calls) {
                    logMessage += `, tool_calls: ${JSON.stringify(message.tool_calls)}`;
                }
                
                logger.verbose(logMessage);
                totalLength += length;
                totalUnits = units;
            });
            logger.info(`[grok responses request contained ${totalLength} ${totalUnits}]`);
        } else if (messages && messages.length === 1) {
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
            logger.info(`[grok responses request sent containing ${length} ${units}]`);
            logger.verbose(`${this.shortenContent(content)}`);
        }

        // Log tools configuration
        if (tools && Object.keys(tools).length > 0) {
            logger.info(`[grok responses request has tools: ${Object.keys(tools).join(', ')}]`);
        }

        if (stream) {
            logger.info(`[grok responses response received as an SSE stream]`);
        } else {
            const parsedResponse = this.parseResponse(responseData);
            
            if (typeof parsedResponse === 'string') {
                const { length, units } = this.getLength(parsedResponse);
                logger.info(`[grok responses response received containing ${length} ${units}]`);
                logger.verbose(`${this.shortenContent(parsedResponse)}`);
            } else {
                logger.info(`[grok responses response received containing object]`);
                logger.verbose(`${JSON.stringify(parsedResponse)}`);
            }
        }

        prompt && prompt.debugInfo && (prompt.debugInfo += `\n${JSON.stringify(data)}`);
    }

    // Convert old search_parameters format to new tools array format
    // The Responses API expects tools as an array: [{ type: "web_search", filters: {...} }, { type: "x_search", ... }]
    convertSearchParametersToTools(searchParams) {
        if (!searchParams || Object.keys(searchParams).length === 0) {
            return null;
        }

        const toolsArray = [];
        const sources = searchParams.sources || [];
        
        // Process each source type
        for (const source of sources) {
            if (source.type === 'web' || source.type === 'news') {
                // Web search tool configuration
                const webSearchTool = { type: 'web_search' };
                const filters = {};
                
                if (source.allowed_websites) filters.allowed_domains = source.allowed_websites.slice(0, 5);
                if (source.excluded_websites) filters.excluded_domains = source.excluded_websites.slice(0, 5);
                if (source.country) webSearchTool.country = source.country;
                if (source.safe_search !== undefined) webSearchTool.safe_search = source.safe_search;
                if (searchParams.enable_image_understanding) webSearchTool.enable_image_understanding = true;
                
                if (Object.keys(filters).length > 0) webSearchTool.filters = filters;
                toolsArray.push(webSearchTool);
            }
            
            if (source.type === 'x') {
                // X search tool configuration
                const xSearchTool = { type: 'x_search' };
                
                if (source.included_x_handles) xSearchTool.allowed_x_handles = source.included_x_handles.slice(0, 10);
                if (source.excluded_x_handles) xSearchTool.excluded_x_handles = source.excluded_x_handles.slice(0, 10);
                if (searchParams.from_date) xSearchTool.from_date = searchParams.from_date;
                if (searchParams.to_date) xSearchTool.to_date = searchParams.to_date;
                if (searchParams.enable_image_understanding) xSearchTool.enable_image_understanding = true;
                if (searchParams.enable_video_understanding) xSearchTool.enable_video_understanding = true;
                
                toolsArray.push(xSearchTool);
            }
        }

        // If no specific sources, enable both web and x search by default
        if (toolsArray.length === 0 && searchParams.mode !== 'off') {
            toolsArray.push({ type: 'web_search' });
            toolsArray.push({ type: 'x_search' });
        }

        return toolsArray.length > 0 ? toolsArray : null;
    }

    // Validate and transform tools configuration for the Responses API
    // Input can be either object format (e.g., { web_search: true, x_search: {...} }) or array format
    // Output is always array format: [{ type: "web_search" }, { type: "x_search", allowed_x_handles: [...] }]
    validateAndTransformTools(tools) {
        // If already an array, validate and return
        if (Array.isArray(tools)) {
            return tools.map(tool => {
                if (typeof tool === 'object' && tool.type) {
                    return tool; // Already in correct format
                }
                return tool;
            });
        }

        // Convert object format to array format
        const toolsArray = [];
        
        if (tools.web_search !== undefined) {
            const webSearch = tools.web_search === true ? {} : (tools.web_search || {});
            const webSearchTool = { type: 'web_search' };
            const filters = {};
            
            if (webSearch.allowed_domain) filters.allowed_domains = webSearch.allowed_domain.slice(0, 5);
            if (webSearch.excluded_domain) filters.excluded_domains = webSearch.excluded_domain.slice(0, 5);
            if (webSearch.country) webSearchTool.country = webSearch.country;
            if (webSearch.safe_search !== undefined) webSearchTool.safe_search = webSearch.safe_search;
            if (webSearch.enable_image_understanding) webSearchTool.enable_image_understanding = true;
            
            if (Object.keys(filters).length > 0) webSearchTool.filters = filters;
            toolsArray.push(webSearchTool);
        }
        
        if (tools.x_search !== undefined) {
            const xSearch = tools.x_search === true ? {} : (tools.x_search || {});
            const xSearchTool = { type: 'x_search' };
            
            if (xSearch.allowed_x_handles) xSearchTool.allowed_x_handles = xSearch.allowed_x_handles.slice(0, 10);
            if (xSearch.excluded_x_handles) xSearchTool.excluded_x_handles = xSearch.excluded_x_handles.slice(0, 10);
            if (xSearch.from_date) xSearchTool.from_date = xSearch.from_date;
            if (xSearch.to_date) xSearchTool.to_date = xSearch.to_date;
            if (xSearch.enable_image_understanding) xSearchTool.enable_image_understanding = true;
            if (xSearch.enable_video_understanding) xSearchTool.enable_video_understanding = true;
            
            toolsArray.push(xSearchTool);
        }

        return toolsArray;
    }

    async getRequestParameters(text, parameters, prompt) {
        const requestParameters = await super.getRequestParameters(text, parameters, prompt);

        // Handle search_parameters (legacy format) - convert to tools
        let tools = {};
        if (parameters.search_parameters) {
            try {
                const searchParams = typeof parameters.search_parameters === 'string' 
                    ? JSON.parse(parameters.search_parameters) 
                    : parameters.search_parameters;
                
                const convertedTools = this.convertSearchParametersToTools(searchParams);
                if (convertedTools) {
                    tools = { ...tools, ...convertedTools };
                }
            } catch (error) {
                logger.warn(`Invalid search_parameters, ignoring: ${error.message}`);
            }
        }

        // Handle direct tools parameter (new format)
        if (parameters.tools) {
            try {
                const directTools = typeof parameters.tools === 'string'
                    ? JSON.parse(parameters.tools)
                    : parameters.tools;
                
                tools = { ...tools, ...directTools };
            } catch (error) {
                logger.warn(`Invalid tools parameter, ignoring: ${error.message}`);
            }
        }

        // If we have tools, validate and transform them
        if (Object.keys(tools).length > 0) {
            requestParameters.tools = this.validateAndTransformTools(tools);
        }

        // Handle inline_citations parameter
        if (parameters.inline_citations !== undefined) {
            requestParameters.inline_citations = parameters.inline_citations;
        } else {
            // Enable inline citations by default for search queries
            requestParameters.inline_citations = true;
        }

        return requestParameters;
    }

    async execute(text, parameters, prompt, cortexRequest) {
        const requestParameters = await this.getRequestParameters(text, parameters, prompt);
        const { stream } = parameters;

        // Convert messages format to input format for Responses API
        // The Responses API uses "input" array instead of "messages"
        if (requestParameters.messages) {
            requestParameters.input = requestParameters.messages;
            delete requestParameters.messages;
        }

        cortexRequest.data = {
            ...(cortexRequest.data || {}),
            ...requestParameters,
        };
        cortexRequest.params = {}; // query params
        cortexRequest.stream = stream;

        return this.executeRequest(cortexRequest);
    }

    // Parse non-streaming response from Responses API
    parseResponse(data) {
        if (!data) return "";

        // Handle Responses API format
        // The Responses API returns: output_text, citations, inline_citations, tool_calls, usage
        if (data.output_text !== undefined || data.output !== undefined) {
            return this.parseResponsesApiFormat(data);
        }

        // Fallback to OpenAI chat completions format (for backward compatibility)
        const { choices } = data;
        if (!choices || !choices.length) {
            return data;
        }

        if (choices.length > 1) {
            return choices;
        }

        const choice = choices[0];
        const message = choice.message;

        const cortexResponse = new CortexResponse({
            output_text: message.content || "",
            finishReason: choice.finish_reason || 'stop',
            usage: data.usage || null,
            metadata: {
                model: this.modelName
            }
        });

        if (message.tool_calls) {
            cortexResponse.toolCalls = message.tool_calls;
        }

        // Handle citations from legacy format
        if (data.citations) {
            cortexResponse.citations = data.citations.map(url => ({
                title: extractCitationTitle(url),
                url: url,
                content: extractCitationTitle(url)
            }));
        }

        return cortexResponse;
    }

    // Parse the new Responses API format
    parseResponsesApiFormat(data) {
        // Extract output text - can be in output_text, text, or output array
        let outputText = data.output_text || data.text || '';
        
        // If output is an array (XAI Responses format), extract text from it
        if (data.output && Array.isArray(data.output)) {
            const textItems = data.output
                .filter(item => item && (item.text || item.type === 'message'))
                .map(item => {
                    if (item.text) return item.text;
                    if (item.content && Array.isArray(item.content)) {
                        return item.content
                            .filter(c => c.type === 'output_text' || c.type === 'text')
                            .map(c => c.text)
                            .join('');
                    }
                    return '';
                });
            
            if (textItems.length > 0) {
                outputText = textItems.join('');
            }
        }

        const cortexResponse = new CortexResponse({
            output_text: outputText,
            finishReason: data.status || 'completed',
            usage: data.usage || null,
            metadata: {
                model: this.modelName,
                id: data.id
            }
        });

        // Handle citations - can come from citations array or be parsed from inline citations
        let citations = [];
        
        // Helper to extract rich metadata from text near a URL citation
        const extractCitationMetadata = (url, text) => {
            const defaultResult = {
                title: extractCitationTitle(url),
                content: '',
                author: null,
                timestamp: null,
                postType: null
            };
            
            if (!text || !url || typeof url !== 'string') return defaultResult;
            
            try {
                // Find where this URL appears in the text (as inline citation)
                const urlEscaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                // Look for up to 300 chars before the citation to capture full context
                const citationRegex = new RegExp(`([^\\n]{0,300})\\[\\[\\d+\\]\\]\\(${urlEscaped}\\)`, 'g');
                const match = citationRegex.exec(text);
                
                if (match) {
                    const contextBefore = (match[1] || '').trim();
                    
                    // Extract author handle (e.g., @elonmusk, @OpenAI)
                    const authorMatch = contextBefore.match(/@([A-Za-z0-9_]+)/);
                    if (authorMatch) {
                        defaultResult.author = authorMatch[1];
                        // Update title to include the author
                        const statusMatch = url.match(/status\/(\d+)/);
                        if (statusMatch) {
                            defaultResult.title = `X Post ${statusMatch[1]} from @${authorMatch[1]}`;
                        }
                    }
                    
                    // Extract timestamp (HH:MM:SS or dates like "December 18, 2025" or "Dec 20, 2025")
                    const timeMatch = contextBefore.match(/(\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:AM|PM|GMT))?)/i);
                    const dateMatch = contextBefore.match(/((?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s*\d{4})/i);
                    if (timeMatch) {
                        defaultResult.timestamp = timeMatch[1];
                    }
                    if (dateMatch) {
                        defaultResult.timestamp = defaultResult.timestamp 
                            ? `${dateMatch[1]} ${defaultResult.timestamp}` 
                            : dateMatch[1];
                    }
                    
                    // Extract post type (quote, reply, repost)
                    const typeMatch = contextBefore.match(/\((quote|reply|repost|thread)\)/i);
                    if (typeMatch) {
                        defaultResult.postType = typeMatch[1].toLowerCase();
                    }
                    
                    // Extract quoted content (text in quotes)
                    const quotedMatch = contextBefore.match(/"([^"]{1,200})"/);
                    if (quotedMatch) {
                        defaultResult.content = quotedMatch[1];
                    } else {
                        // Fall back to the last meaningful chunk of context
                        let content = contextBefore;
                        // Remove markdown formatting and clean up
                        content = content.replace(/\*\*/g, '').replace(/\[View[^\]]*\]/gi, '').trim();
                        // Get the last sentence or phrase
                        const lastSentence = content.match(/[.!?]\s*([^.!?]+)$/);
                        if (lastSentence) {
                            content = lastSentence[1].trim();
                        }
                        if (content.length > 150) {
                            content = '...' + content.slice(-150);
                        }
                        defaultResult.content = content;
                    }
                }
            } catch (e) {
                // If parsing fails, fall back to defaults
                logger.debug(`[grok responses] Citation metadata extraction failed: ${e.message}`);
            }
            
            return defaultResult;
        };
        
        // First, check for explicit citations array from the API
        if (data.citations && Array.isArray(data.citations)) {
            citations = data.citations.map(url => {
                const metadata = extractCitationMetadata(url, outputText);
                return {
                    title: metadata.title,
                    url: url,
                    content: metadata.content || metadata.title,
                    ...(metadata.author && { author: metadata.author }),
                    ...(metadata.timestamp && { timestamp: metadata.timestamp }),
                    ...(metadata.postType && { postType: metadata.postType })
                };
            });
        }
        
        // If no explicit citations, extract them from inline citations in the text
        // Format: [[1]](https://example.com)
        if (citations.length === 0 && outputText) {
            const inlineCitationRegex = /\[\[\d+\]\]\((https?:\/\/[^)]+)\)/g;
            const matches = [...outputText.matchAll(inlineCitationRegex)];
            const uniqueUrls = [...new Set(matches.map(m => m[1]))];
            
            if (uniqueUrls.length > 0) {
                citations = uniqueUrls.map(url => {
                    const metadata = extractCitationMetadata(url, outputText);
                    return {
                        title: metadata.title,
                        url: url,
                        content: metadata.content || metadata.title,
                        ...(metadata.author && { author: metadata.author }),
                        ...(metadata.timestamp && { timestamp: metadata.timestamp }),
                        ...(metadata.postType && { postType: metadata.postType })
                    };
                });
            }
        }
        
        if (citations.length > 0) {
            cortexResponse.citations = citations;
            // Log a sample of enriched citations
            const enrichedCount = citations.filter(c => c.author || c.timestamp || c.postType).length;
            logger.info(`[grok responses] Extracted ${citations.length} citations (${enrichedCount} with rich metadata)`);
            if (enrichedCount > 0) {
                const sample = citations.find(c => c.author || c.timestamp);
                if (sample) {
                    logger.debug(`[grok responses] Sample citation: ${JSON.stringify(sample)}`);
                }
            }
        }

        // Handle inline citations
        if (data.inline_citations && Array.isArray(data.inline_citations)) {
            cortexResponse.metadata.inlineCitations = data.inline_citations;
        }

        // Handle tool calls from Responses API
        if (data.tool_calls && Array.isArray(data.tool_calls)) {
            cortexResponse.metadata.serverSideToolCalls = data.tool_calls;
        }

        return cortexResponse;
    }

    // Override processStreamEvent to handle Responses API streaming format
    processStreamEvent(event, requestProgress) {
        // Check for end of stream
        if (event.data.trim() === '[DONE]') {
            requestProgress.progress = 1;
            this.toolCallsBuffer = [];
            this.contentBuffer = '';
            this.citationsBuffer = [];
            this.inlineCitationsBuffer = [];
            return requestProgress;
        }

        let parsedMessage;
        try {
            parsedMessage = JSON.parse(event.data);
        } catch (error) {
            this.toolCallsBuffer = [];
            this.contentBuffer = '';
            this.citationsBuffer = [];
            this.inlineCitationsBuffer = [];
            throw new Error(`Could not parse stream data: ${error}`);
        }

        // Handle errors
        const streamError = parsedMessage?.error;
        if (streamError) {
            this.toolCallsBuffer = [];
            this.contentBuffer = '';
            this.citationsBuffer = [];
            this.inlineCitationsBuffer = [];
            throw new Error(typeof streamError === 'string' ? streamError : JSON.stringify(streamError));
        }

        // Handle Responses API streaming format
        // The Responses API streams: type, delta, citations (at end), inline_citations (at end)
        
        const type = parsedMessage?.type;
        const delta = parsedMessage?.delta;
        
        // Handle different event types from Responses API
        if (type === 'response.output_text.delta' || type === 'content_block_delta') {
            // Text content delta
            const textDelta = delta?.text || parsedMessage?.text || '';
            if (textDelta) {
                this.contentBuffer += textDelta;
                requestProgress.data = event.data;
            }
        } else if (type === 'response.tool_call.delta') {
            // Server-side tool call information (for observability)
            requestProgress.data = event.data;
        } else if (type === 'response.done' || type === 'message_stop') {
            // Final response with citations
            if (parsedMessage.citations) {
                this.citationsBuffer = parsedMessage.citations;
            }
            if (parsedMessage.inline_citations) {
                this.inlineCitationsBuffer = parsedMessage.inline_citations;
            }
            
            // Add citations to resolver
            const pathwayResolver = requestState[this.requestId]?.pathwayResolver;
            if (pathwayResolver && this.citationsBuffer.length > 0) {
                const citations = this.citationsBuffer.map(url => ({
                    title: extractCitationTitle(url),
                    url: url,
                    content: extractCitationTitle(url)
                }));
                addCitationsToResolver(pathwayResolver, this.contentBuffer, citations);
            }
            
            requestProgress.progress = 1;
            requestProgress.data = event.data;
            
            // Clear buffers
            this.toolCallsBuffer = [];
            this.contentBuffer = '';
            this.citationsBuffer = [];
            this.inlineCitationsBuffer = [];
        } else {
            // Fallback to OpenAI chat completions streaming format
            const choices = parsedMessage?.choices;
            if (choices && choices.length > 0) {
                const choiceDelta = choices[0]?.delta;
                
                // Check for empty events
                const isEmptyEvent = !choiceDelta || 
                    (Object.keys(choiceDelta).length === 0) || 
                    (Object.keys(choiceDelta).length === 1 && choiceDelta.content === '');
                
                const hasFinishReason = choices[0]?.finish_reason;
                
                if (isEmptyEvent && !hasFinishReason) {
                    return requestProgress;
                }
                
                requestProgress.data = event.data;

                // Accumulate content
                if (choiceDelta?.content) {
                    this.contentBuffer += choiceDelta.content;
                }

                // Handle tool calls in streaming response
                if (choiceDelta?.tool_calls) {
                    choiceDelta.tool_calls.forEach((toolCall) => {
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

                // Handle finish reason
                const finishReason = choices[0]?.finish_reason;
                if (finishReason) {
                    const pathwayResolver = requestState[this.requestId]?.pathwayResolver;

                    switch (finishReason.toLowerCase()) {
                        case 'tool_calls':
                            if (this.pathwayToolCallback && this.toolCallsBuffer.length > 0 && pathwayResolver) {
                                const validToolCalls = this.toolCallsBuffer.filter(tc => tc && tc.function && tc.function.name);
                                const toolMessage = {
                                    role: 'assistant',
                                    content: choiceDelta?.content || '',
                                    tool_calls: validToolCalls,
                                };
                                this.pathwayToolCallback(pathwayResolver?.args, toolMessage, pathwayResolver);
                                // Signal to pathwayResolver that tool callback was invoked - prevents [DONE] from ending stream
                                requestProgress.toolCallbackInvoked = true;
                            }
                            this.toolCallsBuffer = [];
                            break;
                        default:
                            // Look to see if we need to add citations to the response
                            addCitationsToResolver(pathwayResolver, this.contentBuffer);
                            
                            // Handle citations from final chunk (legacy format)
                            if (parsedMessage.citations) {
                                const citations = parsedMessage.citations.map(url => ({
                                    title: extractCitationTitle(url),
                                    url: url,
                                    content: extractCitationTitle(url)
                                }));
                                addCitationsToResolver(pathwayResolver, this.contentBuffer, citations);
                            }
                            
                            requestProgress.progress = 1;
                            this.toolCallsBuffer = [];
                            this.contentBuffer = '';
                            this.citationsBuffer = [];
                            this.inlineCitationsBuffer = [];
                            break;
                    }
                }
            }
        }

        return requestProgress;
    }
}

export default GrokResponsesPlugin;

