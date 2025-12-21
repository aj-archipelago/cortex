// sys_tool_grok_x_search.js
// Tool pathway that handles Grok X Platform search using the new Responses API with search tools
import { callPathway } from '../../../../lib/pathwayTools.js';
import logger from '../../../../lib/logger.js';
import { getSearchResultId, extractCitationTitle } from '../../../../lib/util.js';

export default {
    prompt: [],
    timeout: 300,
    inputParameters: {
        text: '',
        userMessage: '',
        includedHandles: { type: 'array', items: { type: 'string' }, default: [] },
        excludedHandles: { type: 'array', items: { type: 'string' }, default: [] },
        fromDate: '',
        toDate: '',
        enableImageUnderstanding: false,
        enableVideoUnderstanding: false,
        maxResults: 10
    },
    toolDefinition: { 
        type: "function",
        icon: "🔍",
        function: {
            name: "SearchXPlatform",
            description: "This tool allows you to search the X platform (formerly Twitter) for current posts, discussions, and real-time information. Use this for finding recent social media content, trending topics, public opinions, and real-time updates. This tool can be slow - 10-60s per search, so only use it when you really want X platform information. Always call this tool in parallel rather than serially if you have several searches to do as it will be faster.",
            parameters: {
                type: "object",
                properties: {
                    text: {
                        type: "string",
                        description: "The complete natural language prompt describing what you want to search for on X platform. This can include topics, hashtags, usernames, or general queries about current events and discussions."
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    },
                    includedHandles: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional array of X handles to include in search (e.g., ['OpenAI', 'AnthropicAI', 'xai']). Maximum 10 handles.",
                        maxItems: 10
                    },
                    excludedHandles: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional array of X handles to exclude from search. Maximum 10 handles. Cannot be used in conjunction with includedHandles.",
                        maxItems: 10
                    },
                    fromDate: {
                        type: "string",
                        description: "Optional date from which to start searching (YYYY-MM-DD format)",
                        format: "date"
                    },
                    toDate: {
                        type: "string",
                        description: "Optional date to which to end searching (YYYY-MM-DD format)",
                        format: "date"
                    },
                    enableImageUnderstanding: {
                        type: "boolean",
                        description: "Enable the agent to analyze images found in X posts",
                        default: false
                    },
                    enableVideoUnderstanding: {
                        type: "boolean",
                        description: "Enable the agent to analyze videos found in X posts",
                        default: false
                    },
                    maxResults: {
                        type: "number",
                        description: "Maximum number of search results to return (default: 10)",
                        minimum: 1,
                        maximum: 50,
                        default: 10
                    }
                },
                required: ["text", "userMessage"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        
        try {
            // Build tools configuration for the new Responses API
            // X Search tool with all supported parameters
            const xSearchConfig = {
                ...(args.includedHandles && args.includedHandles.length > 0 && {
                    allowed_x_handles: args.includedHandles.slice(0, 10)
                }),
                ...(args.excludedHandles && args.excludedHandles.length > 0 && {
                    excluded_x_handles: args.excludedHandles.slice(0, 10)
                }),
                ...(args.fromDate && {
                    from_date: args.fromDate
                }),
                ...(args.toDate && {
                    to_date: args.toDate
                }),
                ...(args.enableImageUnderstanding && {
                    enable_image_understanding: true
                }),
                ...(args.enableVideoUnderstanding && {
                    enable_video_understanding: true
                })
            };

            // Build the tools object for the new Responses API
            const tools = {
                x_search: Object.keys(xSearchConfig).length > 0 ? xSearchConfig : true
            };

            // Call the Grok Live Search pathway with new tools format
            // Use the new Responses API model for X search
            const { model, ...restArgs } = args;
            const result = await callPathway('grok_live_search', { 
                ...restArgs,
                model: 'xai-grok-4-1-fast-responses',
                tools: JSON.stringify(tools),
                inline_citations: true
            }, resolver);
            
            if (resolver.errors && resolver.errors.length > 0) {
                const errorMessages = Array.isArray(resolver.errors) 
                    ? resolver.errors.map(err => err.message || err)
                    : [resolver.errors.message || resolver.errors];
                const errorMessageStr = errorMessages.join('; ');
                return JSON.stringify({ error: errorMessageStr, recoveryMessage: "This tool failed. You should try the backup tool for this function." });
            }

            // Transform response to match expected SearchResponse format
            function transformToSearchResponse(resultData, result) {
                // Extract text and citations from CortexResponse
                const valueText = result || '';
                const citations = resultData.citations || [];
                
                // Create a mapping from citation URLs to search result IDs
                const citationToIdMap = new Map();
                const finalSearchResults = [];
                
                // Process citations array
                if (Array.isArray(citations)) {
                    citations.forEach(citation => {
                        const searchResultId = citation.searchResultId || getSearchResultId();
                        
                        // Check if we already have this URL in searchResults
                        const existingResult = finalSearchResults.find(r => r.url === citation.url);
                        if (!existingResult) {
                            finalSearchResults.push({
                                searchResultId: searchResultId,
                                title: citation.title || extractCitationTitle(citation.url),
                                url: citation.url,
                                content: citation.content || citation.title || extractCitationTitle(citation.url),
                                path: '',
                                wireid: '',
                                source: 'X Platform',
                                slugline: '',
                                date: ''
                            });
                        }
                        
                        // Create mapping for URL replacement
                        if (citation.url) {
                            citationToIdMap.set(citation.url, searchResultId);
                        }
                    });
                }
                
                // Extract inline citations from the text
                // Handle multiple formats: [1](url), [[1]](url), [1(url)]
                const inlineCitationPattern = /\[\[?(\d+)\]?\]\(([^)]+)\)|\[(\d+)\(([^)]+)\)\]/g;
                let match;
                const inlineCitations = new Set();
                
                while ((match = inlineCitationPattern.exec(valueText)) !== null) {
                    const citationNumber = match[1] || match[3];
                    const citationUrl = match[2] || match[4];
                    inlineCitations.add(citationUrl);
                    
                    // If we haven't already processed this URL, add it to search results
                    if (!citationToIdMap.has(citationUrl)) {
                        const searchResultId = getSearchResultId();
                        citationToIdMap.set(citationUrl, searchResultId);
                        
                        finalSearchResults.push({
                            searchResultId: searchResultId,
                            title: extractCitationTitle(citationUrl),
                            url: citationUrl,
                            content: extractCitationTitle(citationUrl),
                            path: '',
                            wireid: '',
                            source: 'X Platform',
                            slugline: '',
                            date: ''
                        });
                    }
                }
                
                // Replace inline citations with our standard format
                let transformedText = valueText.replace(inlineCitationPattern, (match, num1, url1, num2, url2) => {
                    const url = url1 || url2;
                    const searchResultId = citationToIdMap.get(url);
                    return searchResultId ? `:cd_source[${searchResultId}]` : match;
                });
                
                // Also handle simple numbered citations [1] or [[1]] format
                transformedText = transformedText.replace(/\[\[?(\d+)\]?\](?!\()/g, (match, num) => {
                    const citationIndex = parseInt(num) - 1;
                    if (citations[citationIndex]) {
                        const citation = citations[citationIndex];
                        if (citation.searchResultId) {
                            return `:cd_source[${citation.searchResultId}]`;
                        }
                        const url = typeof citation === 'string' ? citation : citation.url;
                        const searchResultId = citationToIdMap.get(url);
                        return searchResultId ? `:cd_source[${searchResultId}]` : match;
                    }
                    return match;
                });
                
                // If no citations found anywhere, create a single search result with the content
                if (finalSearchResults.length === 0) {
                    finalSearchResults.push({
                        searchResultId: getSearchResultId(),
                        title: 'X Platform Search Results',
                        url: 'https://x.com/search',
                        content: transformedText,
                        path: '',
                        wireid: '',
                        source: 'X Platform',
                        slugline: '',
                        date: ''
                    });
                }
                
                return {
                    transformedText: transformedText,
                    searchResults: finalSearchResults
                };
            }

            resolver.pathwayResultData.toolUsed = 'SearchXPlatform';
           
            // Transform the CortexResponse and return the search response
            const transformedData = transformToSearchResponse(resolver.pathwayResultData, result);
            return JSON.stringify({ 
                _type: "SearchResponse", 
                value: transformedData.searchResults,
                text: transformedData.transformedText
            });
        } catch (e) {
            const errorMessage = e?.message || e?.toString() || String(e);
            logger.error(`Error in Grok X Platform search: ${errorMessage}`);
            
            // Return error response instead of throwing so agent can see and adjust
            return JSON.stringify({ 
                error: errorMessage, 
                recoveryMessage: "This tool failed. You should try the backup tool for this function." 
            });
        }
    }
};
