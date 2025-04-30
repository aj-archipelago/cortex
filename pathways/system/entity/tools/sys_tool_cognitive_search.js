// sys_tool_cognitive_search.js
// Tool pathway that handles cognitive search across various indexes
import { callPathway } from '../../../../lib/pathwayTools.js';
import { Prompt } from '../../../../server/prompt.js';
import logger from '../../../../lib/logger.js';

export default {
    prompt: [],
    useInputChunking: false,
    enableDuplicateRequests: false,
    inputParameters: {
        text: '',
        filter: '',
        top: 50,
        titleOnly: false,
        stream: false,
        indexName: '', // Required: 'indexcortex', 'indexucmsaja', 'indexucmsaje', or 'indexwires'
        dataSources: [""] // Optional: filter which data sources to search
    },
    timeout: 300,
    toolDefinition: [
        {
            type: "function",
            icon: "📂",
            function: {
                name: "SearchPersonal",
                description: "Search through the user's personal documents and uploaded files. Use this for finding information in user-provided content.",
                parameters: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string",
                            description: "The search query to find relevant content in personal documents. Can be a specific phrase or '*' for all documents."
                        },
                        filter: {
                            type: "string",
                            description: "Optional OData filter expression for date filtering (e.g. 'date ge 2024-02-22T00:00:00Z')"
                        },
                        top: {
                            type: "integer",
                            description: "Number of results to return (default is 50)"
                        },
                        titleOnly: {
                            type: "boolean",
                            description: "If true, only return document titles without content"
                        },
                        userMessage: {
                            type: "string",
                            description: "A user-friendly message that describes what you're doing with this tool"
                        }
                    },
                    required: ["text", "userMessage"]
                }
            }
        },
        {
            type: "function",
            function: {
                name: "SearchAJA",
                icon: "📰",
                description: "Search through Al Jazeera Arabic news articles. Use this for finding Arabic news content.",
                parameters: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string",
                            description: "The search query in Arabic to find relevant news articles. Can be a specific phrase or '*' for all articles."
                        },
                        filter: {
                            type: "string",
                            description: "Optional OData filter expression for date filtering (e.g. 'date ge 2024-02-22T00:00:00Z')"
                        },
                        top: {
                            type: "integer",
                            description: "Number of results to return (default is 50)"
                        },
                        titleOnly: {
                            type: "boolean",
                            description: "If true, only return article titles without content"
                        },
                        userMessage: {
                            type: "string",
                            description: "A user-friendly message that describes what you're doing with this tool"
                        }
                    },
                    required: ["text", "userMessage"]
                }
            }
        },
        {
            type: "function",
            icon: "📰",
            function: {
                name: "SearchAJE",
                description: "Search through Al Jazeera English news articles. Use this for finding English news content.",
                parameters: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string",
                            description: "The search query in English to find relevant news articles. Can be a specific phrase or '*' for all articles."
                        },
                        filter: {
                            type: "string",
                            description: "Optional OData filter expression for date filtering (e.g. 'date ge 2024-02-22T00:00:00Z')"
                        },
                        top: {
                            type: "integer",
                            description: "Number of results to return (default is 50)"
                        },
                        titleOnly: {
                            type: "boolean",
                            description: "If true, only return article titles without content"
                        },
                        userMessage: {
                            type: "string",
                            description: "A user-friendly message that describes what you're doing with this tool"
                        }
                    },
                    required: ["text", "userMessage"]
                }
            }
        },
        {
            type: "function",
            icon: "⚡️",
            function: {
                name: "SearchWires",
                description: "Search through news wires from all sources. Use this for finding the latest news and articles.",
                parameters: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string",
                            description: "The search query to find relevant news wires. Can be a specific phrase or '*' for all wires."
                        },
                        filter: {
                            type: "string",
                            description: "Optional OData filter expression for date filtering (e.g. 'date ge 2024-02-22T00:00:00Z')"
                        },
                        top: {
                            type: "integer",
                            description: "Number of results to return (default is 50)"
                        },
                        titleOnly: {
                            type: "boolean",
                            description: "If true, only return wire titles without content"
                        },
                        userMessage: {
                            type: "string",
                            description: "A user-friendly message that describes what you're doing with this tool"
                        }
                    },
                    required: ["text", "userMessage"]
                }
            }
        }
    ],

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const { text, filter, top, titleOnly, stream, dataSources } = args;

        // Map tool names to index names
        const toolToIndex = {
            'searchpersonal': 'indexcortex',
            'searchaja': 'indexucmsaja',
            'searchaje': 'indexucmsaje',
            'searchwires': 'indexwires'
        };

        // Get the tool name from the function call
        const toolName = args.toolFunction;
        if (!toolName || !toolToIndex[toolName.toLowerCase()]) {
            throw new Error(`Invalid tool name: ${toolName}. Must be one of: ${Object.keys(toolToIndex).join(', ')}`);
        }

        const indexName = toolToIndex[toolName];

        // Map index names to data source types
        const indexToSource = {
            'indexcortex': 'mydata',
            'indexucmsaja': 'aja',
            'indexucmsaje': 'aje',
            'indexwires': 'wires'
        };

        // Check if this data source is allowed
        const allowAllSources = !dataSources?.length || (dataSources.length === 1 && dataSources[0] === "");
        const sourceType = indexToSource[indexName];
        if (!allowAllSources && !dataSources.includes(sourceType)) {
            return JSON.stringify({ _type: "SearchResponse", value: [] });
        }

        try {
            // Call the cognitive search pathway
            const response = await callPathway('cognitive_search', {
                ...args,
                text,
                filter,
                top: top || 50,
                titleOnly: titleOnly || false,
                indexName,
                stream: stream || false
            });

            const parsedResponse = JSON.parse(response);
            return JSON.stringify({ _type: "SearchResponse", value: parsedResponse.value || [] });
        } catch (e) {
            logger.error(`Error in cognitive search for index ${indexName}: ${e}`);
            throw e;
        }
    }
}; 