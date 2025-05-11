// sys_tool_cognitive_search.js
// Tool pathway that handles cognitive search across various indexes
import { callPathway } from '../../../../lib/pathwayTools.js';
import { Prompt } from '../../../../server/prompt.js';
import logger from '../../../../lib/logger.js';
import { getSearchResultId } from '../../../../lib/util.js';

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
        indexName: ''
    },
    timeout: 300,
    toolDefinition: [
        {
            type: "function",
            icon: "📂",
            function: {
                name: "SearchPersonalIndex",
                description: "Search through the user's index of personal documents and indexed uploaded files and retrieve the content of the files. Use this tool if the user refers to a file or a document that you don't see uploaded elsewhere in your context. Some file types (e.g. Word documents, Excel documents, very large files, etc.) cannot be attached to a message and will be chunked and indexed and stored in the personal index.",
                parameters: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string",
                            description: "The search query to find relevant content in personal documents. Can be a specific phrase or '*' for all documents, or a query formatted with AI Search syntax."
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
                            description: "If true, only return document titles without content - faster and great for counting results"
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
                name: "SearchAJA",
                description: "Search Al Jazeera Arabic news articles. Use this for finding Arabic news content including the latest news and articles. Make sure to include a date filter when looking for recent articles.",
                parameters: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string",
                            description: "The search query in Arabic to find relevant news articles. Can be a specific phrase or '*' for all articles, or a query formatted with AI Search syntax."
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
                            description: "If true, only return article titles without content - faster and great for counting results"
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
                description: "Search Al Jazeera English news articles. Use this for finding English news content including the latest news and articles. Make sure to include a date filter when looking for recent articles.",
                parameters: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string",
                            description: "The search query in English to find relevant news articles. Can be a specific phrase or '*' for all articles, or a query formatted with AI Search syntax."
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
                            description: "If true, only return article titles without content - faster and great for counting results"
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
                description: "Search news wires from Reuters, AFP, AP, and other news agencies. Use this for finding the latest news and articles from the wires. Make sure to include a date filter when looking for recent articles.",
                parameters: {
                    type: "object",
                    properties: {
                        text: {
                            type: "string",
                            description: "The search query to find relevant news wires. Can be a specific phrase or '*' for all wires, or a query formatted with AI Search syntax."
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
                            description: "If true, only return wire titles without content - faster and great for counting results"
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
        const { text, filter, top, titleOnly, stream, chatId, indexName, semanticConfiguration } = args;

        // Map tool names to index names
        const toolToIndex = {
            'searchpersonal': 'indexcortex',
            'searchaja': 'indexucmsaja',
            'searchaje': 'indexucmsaje',
            'searchwires': 'indexwires'
        };

        // Helper function to remove vector fields from search results
        const removeVectorFields = (result) => {
            const { text_vector, image_vector, ...cleanResult } = result;
            return cleanResult;
        };

        // Get the tool name from the function call
        const toolName = args.toolFunction;
        const toolIndexName = indexName || toolToIndex[toolName];

        if (!toolName || !toolIndexName) {
            throw new Error(`Invalid tool name: ${toolName}. Search not allowed.`);
        }

        try {
            // Call the cognitive search pathway
            const response = await callPathway('cognitive_search', {
                ...args,
                text,
                filter,
                top: top || 50,
                titleOnly: titleOnly || false,
                indexName: toolIndexName,
                semanticConfiguration,
                stream: stream || false,
                chatId
            });

            const parsedResponse = JSON.parse(response);

            const combinedResults = [];

            // Add OData context and count information if present
            if (parsedResponse["@odata.context"]) {
                combinedResults.push({
                    searchResultId: getSearchResultId(),
                    key: "@odata.context",
                    content: parsedResponse["@odata.context"],
                    source_type: 'metadata'
                });
            }
            if (parsedResponse["@odata.count"]) {
                combinedResults.push({
                    searchResultId: getSearchResultId(),
                    key: "@odata.count",
                    content: parsedResponse["@odata.count"].toString(),
                    source_type: 'metadata'
                });
            }

            if (parsedResponse.value && Array.isArray(parsedResponse.value)) {
                // Filter out vector fields from each result before adding to combinedResults
                combinedResults.push(...parsedResponse.value.map(result => ({
                    ...removeVectorFields(result),
                    searchResultId: getSearchResultId()
                })));
            }
            // Extract semantic answers
            const answers = parsedResponse["@search.answers"];
            if (answers && Array.isArray(answers)) {
                const formattedAnswers = answers.map(ans => ({
                    // Create a pseudo-document structure for answers
                    searchResultId: getSearchResultId(),
                    title: "", // no title for answers
                    content: ans.text || "", // Use text as content
                    key: ans.key, // Keep the key if needed later
                    score: ans.score, // Keep score
                    source_type: 'answer' // Add a type identifier
                    // url: null - Answers don't have URLs
                }));
                combinedResults.push(...formattedAnswers);
            }

            return JSON.stringify({ _type: "SearchResponse", value: combinedResults });
        } catch (e) {
            logger.error(`Error in cognitive search for index ${indexName}: ${e}`);
            throw e;
        }
    }
}; 