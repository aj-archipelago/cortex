// sys_tool_google_search.js
// Tool pathway that handles Google Custom Search functionality
import { callPathway } from '../../../../lib/pathwayTools.js';
import logger from '../../../../lib/logger.js';
import { config } from '../../../../config.js';
import { getSearchResultId } from '../../../../lib/util.js';

export default {
    prompt: [],
    timeout: 300,
    toolDefinition: { 
        type: "function",
        icon: "🌐",
        function: {
            name: "SearchInternet",
            description: "Search the internet for current knowledge and events. This is a simple pass-through tool: it calls Google CSE with your parameters and returns normalized results with unique IDs for citation. Prefer strict time filters and reputable sources via CSE parameters.",
            parameters: {
                type: "object",
                properties: {
                    q: {
                        type: "string",
                        description: "The complete query to pass to Google CSE using Google's search syntax."
                    },
                    num: {
                        type: "integer",
                        description: "Number of results to return (1-10). Default 10."
                    },
                    start: {
                        type: "integer",
                        description: "The index of the first result to return for pagination (1-based)."
                    },
                    safe: {
                        type: "string",
                        description: "SafeSearch setting: 'off' or 'active'."
                    },
                    dateRestrict: {
                        type: "string",
                        description: "Restrict results to recent content (e.g., 'd1' for past day, 'w1' week, 'm1' month, 'y1' year)."
                    },
                    siteSearch: {
                        type: "string",
                        description: "Restrict results to a specific site or domain."
                    },
                    siteSearchFilter: {
                        type: "string",
                        description: "'e' to exclude or 'i' to include the siteSearch restriction."
                    },
                    cx: {
                        type: "string",
                        description: "Optional: override the default Google Custom Search Engine ID for this call."
                    },
                    searchType: {
                        type: "string",
                        description: "Set to 'image' to search for images."
                    },
                    gl: {
                        type: "string",
                        description: "Country code for results (geolocation)."
                    },
                    hl: {
                        type: "string",
                        description: "Interface language."
                    },
                    lr: {
                        type: "string",
                        description: "Restrict results by language (e.g., 'lang_en')."
                    },
                    sort: {
                        type: "string",
                        description: "Sorting expression (e.g., 'date')."
                    },
                    exactTerms: {
                        type: "string",
                        description: "Terms that must appear in the results."
                    },
                    excludeTerms: {
                        type: "string",
                        description: "Terms to exclude from results."
                    },
                    orTerms: {
                        type: "string",
                        description: "Alternative terms; results must include at least one."
                    },
                    fileType: {
                        type: "string",
                        description: "Restrict results by file type (e.g., 'pdf')."
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    }
                },
                required: ["q", "userMessage"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        // Check if Google CSE credentials are available
        const env = config.getEnv();
        const googleKey = env["GOOGLE_CSE_KEY"];
        const googleCx = env["GOOGLE_CSE_CX"];
        if (!googleKey || !googleCx) {
            throw new Error("Google Custom Search is not available - missing GOOGLE_CSE_KEY and/or GOOGLE_CSE_CX");
        }

        try {
            // Pass-through: call Google CSE with provided args
            const response = await callPathway('google_cse', { 
                ...args,
                text: args.q
            }, resolver);

            if (resolver.errors && resolver.errors.length > 0) {
                const errorMessages = Array.isArray(resolver.errors) 
                    ? resolver.errors.map(err => err.message || err)
                    : [resolver.errors.message || resolver.errors];
                return JSON.stringify({ _type: "SearchError", value: errorMessages, recoveryMessage: "This tool failed. You should try the backup tool for this function." });
            }

            // Check if response is null or empty
            if (!response) {
                logger.error('Google CSE search returned null response');
                return JSON.stringify({ _type: "SearchError", value: ["No response received from Google CSE"], recoveryMessage: "This tool failed. You should try the backup tool for this function." });
            }

            let parsedResponse;
            try {
                parsedResponse = JSON.parse(response);
            } catch (parseError) {
                logger.error(`Failed to parse Google CSE response: ${parseError.message}`);
                return JSON.stringify({ _type: "SearchError", value: ["Invalid response format from Google CSE"], recoveryMessage: "This tool failed. You should try the backup tool for this function." });
            }

            const results = [];
            const items = parsedResponse.items || [];
            // Normalize results from Google CSE items
            for (const item of items) {
                results.push({
                    searchResultId: getSearchResultId(),
                    title: item.title || item.htmlTitle || '',
                    url: item.link || item.formattedUrl || '',
                    content: item.snippet || item.htmlSnippet || ''
                });
            }

            resolver.tool = JSON.stringify({ toolUsed: "GoogleSearch" });
            return JSON.stringify({ _type: "SearchResponse", value: results });
        } catch (e) {
            logger.error(`Error in Google CSE search: ${e}`);
            throw e;
        }
    }
}; 
