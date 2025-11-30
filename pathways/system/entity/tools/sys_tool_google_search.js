// sys_tool_google_search.js
// Tool pathway that handles Google Custom Search functionality
import { callPathway } from '../../../../lib/pathwayTools.js';
import logger from '../../../../lib/logger.js';
import { config } from '../../../../config.js';
import { getSearchResultId } from '../../../../lib/util.js';

/**
 * Validates Google CSE parameters according to API requirements
 * @param {Object} args - The parameters to validate
 * @returns {string|null} - Error message if validation fails, null if valid
 */
function validateParameters(args) {
    // Validate required parameter: q
    if (!args.q || typeof args.q !== 'string' || args.q.trim() === '') {
        return "Parameter 'q' (query) is required and must be a non-empty string.";
    }

    // Validate num: must be integer between 1-10
    if (args.num !== undefined) {
        if (!Number.isInteger(args.num) || args.num < 1 || args.num > 10) {
            return "Parameter 'num' must be an integer between 1 and 10 (inclusive).";
        }
    }

    // Validate start: must be integer >= 1
    if (args.start !== undefined) {
        if (!Number.isInteger(args.start) || args.start < 1) {
            return "Parameter 'start' must be an integer greater than or equal to 1.";
        }
    }

    // Validate safe: must be 'off' or 'active'
    if (args.safe !== undefined) {
        if (args.safe !== 'off' && args.safe !== 'active') {
            return "Parameter 'safe' must be either 'off' or 'active'.";
        }
    }

    // Validate dateRestrict: format like 'd1', 'w1', 'm1', 'y1' (letter followed by optional number)
    if (args.dateRestrict !== undefined && args.dateRestrict !== '') {
        if (typeof args.dateRestrict !== 'string') {
            return "Parameter 'dateRestrict' must be a string (e.g., 'd1' for past day, 'w1' for week, 'm1' for month, 'y1' for year).";
        }
        // Format: single letter (d, w, m, y) followed by optional digits
        if (!/^[dwmy]\d*$/.test(args.dateRestrict)) {
            return "Parameter 'dateRestrict' must be in format 'd1', 'w1', 'm1', 'y1' (letter d/w/m/y followed by optional number).";
        }
    }

    // Validate siteSearchFilter: must be 'e' or 'i'
    if (args.siteSearchFilter !== undefined && args.siteSearchFilter !== '') {
        if (args.siteSearchFilter !== 'e' && args.siteSearchFilter !== 'i') {
            return "Parameter 'siteSearchFilter' must be either 'e' (exclude) or 'i' (include).";
        }
    }

    // Validate searchType: should be 'image' if provided
    if (args.searchType !== undefined && args.searchType !== '') {
        if (typeof args.searchType !== 'string' || args.searchType !== 'image') {
            return "Parameter 'searchType' must be 'image' if provided.";
        }
    }

    // Validate gl: should be a 2-letter country code (basic validation)
    if (args.gl !== undefined && args.gl !== '') {
        if (typeof args.gl !== 'string' || args.gl.length !== 2 || !/^[a-z]{2}$/i.test(args.gl)) {
            return "Parameter 'gl' must be a 2-letter country code (e.g., 'us', 'uk', 'fr').";
        }
    }

    // Validate string parameters: ensure they're strings if provided
    const stringParams = ['siteSearch', 'hl', 'lr', 'sort', 'exactTerms', 'excludeTerms', 'orTerms', 'fileType', 'cx'];
    for (const param of stringParams) {
        if (args[param] !== undefined && args[param] !== '' && typeof args[param] !== 'string') {
            return `Parameter '${param}' must be a string.`;
        }
    }

    // Validate lr: if provided, should start with 'lang_' (basic validation)
    if (args.lr !== undefined && args.lr !== '') {
        if (!args.lr.startsWith('lang_')) {
            return "Parameter 'lr' should be in format 'lang_XX' (e.g., 'lang_en', 'lang_fr').";
        }
    }

    return null; // All validations passed
}

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
        // Validate parameters before proceeding
        const validationError = validateParameters(args);
        if (validationError) {
            logger.error(`Google CSE parameter validation failed: ${validationError}`);
            return JSON.stringify({ 
                error: validationError, 
                recoveryMessage: "Please correct the parameter format and try again." 
            });
        }

        // Check if Google CSE credentials are available
        const env = config.getEnv();
        const googleKey = env["GOOGLE_CSE_KEY"];
        const googleCx = env["GOOGLE_CSE_CX"];
        if (!googleKey || !googleCx) {
            logger.error('Google Custom Search is not available - missing credentials');
            return JSON.stringify({ 
                error: "Google Custom Search is not available - missing GOOGLE_CSE_KEY and/or GOOGLE_CSE_CX", 
                recoveryMessage: "This tool is not configured. You should try a different search tool." 
            });
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
                const errorMessageStr = errorMessages.join('; ');
                return JSON.stringify({ error: errorMessageStr, recoveryMessage: "This tool failed. You should try the backup tool for this function." });
            }

            // Check if response is null or empty
            if (!response) {
                logger.error('Google CSE search returned null response');
                return JSON.stringify({ error: "No response received from Google CSE", recoveryMessage: "This tool failed. You should try the backup tool for this function." });
            }

            let parsedResponse;
            try {
                parsedResponse = JSON.parse(response);
            } catch (parseError) {
                logger.error(`Failed to parse Google CSE response: ${parseError.message}`);
                return JSON.stringify({ error: `Invalid response format from Google CSE: ${parseError.message}`, recoveryMessage: "This tool failed. You should try the backup tool for this function." });
            }

            // Check if parsed response indicates an error
            if (parsedResponse.error || parsedResponse.Error) {
                let errorMsg;
                if (parsedResponse.Error !== undefined) {
                    if (typeof parsedResponse.Error === 'object') {
                        errorMsg = parsedResponse.Error.message || JSON.stringify(parsedResponse.Error);
                    } else {
                        errorMsg = parsedResponse.Error;
                    }
                } else if (parsedResponse.error !== undefined) {
                    if (typeof parsedResponse.error === 'object') {
                        errorMsg = parsedResponse.error.message || JSON.stringify(parsedResponse.error);
                    } else {
                        errorMsg = parsedResponse.error;
                    }
                } else {
                    errorMsg = 'Unknown error from Google CSE';
                }
                logger.error(`Google CSE API error: ${errorMsg}`);
                
                // Provide helpful recovery message based on error type
                let recoveryMessage = "This tool failed. You should try the backup tool for this function.";
                if (typeof errorMsg === 'string') {
                    if (errorMsg.includes('quota') || errorMsg.includes('limit')) {
                        recoveryMessage = "Google CSE quota or rate limit exceeded. Please try again later or use a different search tool.";
                    } else if (errorMsg.includes('invalid') || errorMsg.includes('badRequest')) {
                        recoveryMessage = "The search query or parameters are invalid. Please adjust your search parameters and try again.";
                    }
                }
                
                return JSON.stringify({ 
                    error: errorMsg, 
                    recoveryMessage: recoveryMessage 
                });
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
            const errorMessage = e?.message || e?.toString() || String(e);
            logger.error(`Error in Google CSE search: ${errorMessage}`);
            
            // Return error response instead of throwing so agent can see and adjust
            return JSON.stringify({ 
                error: errorMessage, 
                recoveryMessage: "This tool failed. You should try the backup tool for this function." 
            });
        }
    }
}; 
