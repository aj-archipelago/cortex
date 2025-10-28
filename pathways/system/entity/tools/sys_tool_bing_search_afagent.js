// sys_tool_bing_search_afagent.js
// Tool pathway that handles Bing web search functionality with minimal parsing
import { callPathway } from '../../../../lib/pathwayTools.js';
import logger from '../../../../lib/logger.js';
import { config } from '../../../../config.js';
import { getSearchResultId } from '../../../../lib/util.js';

export default {
    prompt: [],
    timeout: 300,
    toolDefinition: { 
        type: "function",
        enabled: false,
        icon: "🌐",
        function: {
            name: "SearchInternet",
            description: "This tool allows you to search sources on the internet by calling another agent that has Bing search access. Use this for current events, news, fact-checking, and information requiring citation. Always call this tool in parallel rather than serially if you have several searches to do as it will be faster.",
            parameters: {
                type: "object",
                properties: {
                    text: {
                        type: "string",
                        description: "The complete natural language prompt describing what you want to search for. This is going to an AI agent that has Bing search access - you can be as detailed or general as you want."
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    },
                    count: {
                        type: "integer",
                        description: "Number of search results to return (default: 25, minimum: 1, maximum: 50)",
                    },
                    freshness: {
                        type: "string",
                        description: "Time filter for search results in Bing freshness format (e.g., 'day', 'week', 'month', 'year', or an explicit date range 'YYYY-MM-DD..YYYY-MM-DD' or single date 'YYYY-MM-DD')",
                    },
                    market: {
                        type: "string",
                        description: "Market/locale for search results (e.g., 'en-us', 'en-gb')",
                    },
                    set_lang: {
                        type: "string",
                        description: "Language for search results (e.g., 'en', 'es', 'fr')",
                    }
                },
                required: ["text", "userMessage"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {

        // Check if Bing API key is available
        const servicePrincipalAvailable = !!config.getEnv()["AZURE_SERVICE_PRINCIPAL_CREDENTIALS"];
        if (!servicePrincipalAvailable) {
            throw new Error("Service Principal for Bing Search Agent is not available!");
        }

        try {
            // Call the Bing search pathway
            //remove model from args as bing_afagent has model in its own
            const { model, ...restArgs } = args;
            
            // Extract search parameters and pass them through
            const searchParams = {};
            if (args.count !== undefined) searchParams.count = args.count;
            if (args.freshness !== undefined) searchParams.freshness = args.freshness;
            if (args.market !== undefined) searchParams.market = args.market;
            if (args.set_lang !== undefined) searchParams.set_lang = args.set_lang;
            
            const rawResponse = await callPathway('bing_afagent', { 
                tool_choice: 'auto',
                ...restArgs,
                ...searchParams
            }, resolver);
            
            // Add error handling for malformed JSON
            let response;
            try {
                response = JSON.parse(rawResponse);
            } catch (parseError) {
                logger.error(`Failed to parse bing_afagent response as JSON: ${parseError.message}`);
                logger.error(`Raw response: ${rawResponse}`);
                throw new Error(`Invalid JSON response from bing_afagent: ${parseError.message}`);
            }

            if (resolver.errors && resolver.errors.length > 0) {
                const errorMessages = Array.isArray(resolver.errors) 
                    ? resolver.errors.map(err => err.message || err)
                    : [resolver.errors.message || resolver.errors];
                return JSON.stringify({ _type: "SearchError", value: errorMessages });
            }

            // Transform response to match expected SearchResponse format
            function transformToSearchResponse(response) {
                let valueText = response.value || '';
                const annotations = response.annotations || [];
                
                // Create a mapping from citation text to search result IDs
                const citationToIdMap = new Map();
                const citationPattern = /【\d+:\d+†source】/g;
                
                // Replace citation markers with search result IDs
                valueText = valueText.replace(citationPattern, (match) => {
                    if (!citationToIdMap.has(match)) {
                        citationToIdMap.set(match, getSearchResultId());
                    }
                    return `:cd_source[${citationToIdMap.get(match)}]`;
                });
                
                // Transform annotations to search result objects
                const searchResults = annotations.map(annotation => {
                    if (annotation.type === "url_citation" && annotation.url_citation) {
                        const citationText = annotation.text;
                        const searchResultId = citationToIdMap.get(citationText) || getSearchResultId();
                        
                        return {
                            searchResultId: searchResultId,
                            title: annotation.url_citation.title || '',
                            url: annotation.url_citation.url || '',
                            content: annotation.url_citation.title || annotation.url_citation.url || '', // Individual result content
                            path: '',
                            wireid: '',
                            source: '',
                            slugline: '',
                            date: ''
                        };
                    }
                    return null;
                }).filter(result => result !== null);
                
                // If no annotations, create a single search result with the content
                if (searchResults.length === 0) {
                    searchResults.push({
                        searchResultId: getSearchResultId(),
                        title: '',
                        url: '',
                        content: valueText, // Use the full transformed text as content
                        path: '',
                        wireid: '',
                        source: '',
                        slugline: '',
                        date: ''
                    });
                }
                
                return {
                    transformedText: valueText, // The full text with citations replaced
                    searchResults: searchResults // Individual search results for citation extraction
                };
            }

            const transformedData = transformToSearchResponse(response);

            resolver.tool = JSON.stringify({ toolUsed: "SearchInternetAgent2" });
            
            // Return the full transformed text as the main result, and include search results for citation extraction
            return JSON.stringify({ 
                _type: "SearchResponse", 
                value: transformedData.searchResults,
                text: transformedData.transformedText // The full transformed text with citations
            });
        } catch (e) {
            logger.error(`Error in Bing search: ${e}`);
            throw e;
        }
    }
}; 