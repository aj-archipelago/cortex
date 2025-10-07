// sys_tool_grok_x_search.js
// Tool pathway that handles Grok Live Search functionality specifically for X platform search
import { callPathway } from '../../../../lib/pathwayTools.js';
import logger from '../../../../lib/logger.js';
import { getSearchResultId, extractCitationTitle } from '../../../../lib/util.js';

export default {
    prompt: [],
    timeout: 300,
    inputParameters: {
        text: '',
        userMessage: '',
        includedHandles: { type: '[String]', value: [] },
        excludedHandles: { type: '[String]', value: [] },
        minFavorites: 0,
        minViews: 0,
        maxResults: 10
    },
    toolDefinition: { 
        type: "function",
        icon: "🔍",
        function: {
            name: "SearchXPlatform",
            description: "This tool allows you to search the X platform (formerly Twitter) for current posts, discussions, and real-time information. Use this for finding recent social media content, trending topics, public opinions, and real-time updates. Always call this tool in parallel rather than serially if you have several searches to do as it will be faster.",
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
                        description: "Optional date from which to start searching (YYYY-MM-DD)",
                        format: "date"
                    },
                    toDate: {
                        type: "string",
                        description: "Optional date to which to end searching (YYYY-MM-DD)",
                        format: "date"
                    },
                    minFavorites: {
                        type: "number",
                        description: "Minimum number of favorites (likes) that a post must have to be included. Use this to filter to most liked posts.",
                        minimum: 0
                    },
                    minViews: {
                        type: "number",
                        description: "Minimum number of views that a post must have to be included. Use this to filter to most viewed posts.",
                        minimum: 0
                    },
                    maxResults: {
                        type: "number",
                        description: "Maximum number of search results to return (default: 10, max: 50)",
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
            // Build search parameters for X platform search
            const searchParameters = {
                mode: 'auto',
                return_citations: true,
                max_search_results: args.maxResults || 10,
                sources: [{
                    type: 'x',
                    ...(args.includedHandles && args.includedHandles.length > 0 && {
                        included_x_handles: args.includedHandles
                    }),
                    ...(args.excludedHandles && args.excludedHandles.length > 0 && {
                        excluded_x_handles: args.excludedHandles
                    }),
                    ...(args.minFavorites && {
                        post_favorite_count: args.minFavorites
                    }),
                    ...(args.minViews && {
                        post_view_count: args.minViews
                    })
                }]
            };

            // Call the Grok Live Search pathway
            const { model, ...restArgs } = args;
            const result = await callPathway('grok_live_search', { 
                ...restArgs,
                search_parameters: JSON.stringify(searchParameters)
            }, resolver);
            
            if (resolver.errors && resolver.errors.length > 0) {
                const errorMessages = Array.isArray(resolver.errors) 
                    ? resolver.errors.map(err => err.message || err)
                    : [resolver.errors.message || resolver.errors];
                return JSON.stringify({ _type: "SearchError", value: errorMessages });
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
                
                // Extract inline citations from the text in format [1](https://example.com) or [1(https://example.com)]
                const inlineCitationPattern = /\[(\d+)\]\(([^)]+)\)|\[(\d+)\(([^)]+)\)\]/g;
                let match;
                const inlineCitations = new Set();
                
                while ((match = inlineCitationPattern.exec(valueText)) !== null) {
                    // Handle both formats: [1](url) and [1(url)]
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
                
                // Also handle simple numbered citations [1] format
                transformedText = transformedText.replace(/\[(\d+)\]/g, (match, num) => {
                    const citationIndex = parseInt(num) - 1;
                    if (citations[citationIndex]) {
                        const citation = citations[citationIndex];
                        // If citation is already in searchResults format, use its searchResultId
                        if (citation.searchResultId) {
                            return `:cd_source[${citation.searchResultId}]`;
                        }
                        // Otherwise, try to find by URL
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
                        url: 'https://x.com/search', // Provide a valid URL for X platform search
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
            logger.error(`Error in Grok X Platform search: ${e}`);
            throw e;
        }
    }
};