// sys_tool_browser.js
// Tool pathway that handles web page content scraping functionality
import logger from '../../../../lib/logger.js';
import { config } from '../../../../config.js';
import { getSearchResultId } from '../../../../lib/util.js';

export default {
    prompt: [],
    timeout: 300,
    toolDefinition: { 
        type: "function",
        icon: "🌎",
        function: {
            name: "FetchWebPageContentJina",
            description: "This tool allows you to fetch and extract the text content from any webpage using the Jina reader API. Use this when you need to analyze or understand the content of a specific webpage.",
            parameters: {
                type: "object",
                properties: {
                    url: {
                        type: "string",
                        description: "The complete URL of the webpage to fetch and analyze"
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    }
                },
                required: ["url", "userMessage"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        // Check if browser service URL is available
        const jinaApiKey = config.get('jinaApiKey');
        if (!jinaApiKey) {
            throw new Error("Jina API key is not available - missing JINA_API_KEY configuration");
        }

        try {
            const scrapeUrl = `https://r.jina.ai/${encodeURIComponent(args.url)}`;
            const token = `Bearer ${jinaApiKey}`;

            const response = await fetch(scrapeUrl, {
            headers: {
                'Authorization': token
            }
            });

            if (!response.ok) {
                throw new Error(`Browser service returned error: ${response.status} ${response.statusText}`);
            }

            const data = await response.text();
            
            // Create a result object with the scraped content
            const result = {
                searchResultId: getSearchResultId(),
                title: "Webpage Content",
                url: args.url,
                content: data
            };

            resolver.tool = JSON.stringify({ toolUsed: "WebPageContent" });
            return JSON.stringify({ _type: "SearchResponse", value: [result] });
        } catch (e) {
            logger.error(`Error in browser tool: ${e}`);
            throw e;
        }
    }
}; 