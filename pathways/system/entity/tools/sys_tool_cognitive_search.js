// sys_tool_cognitive_search.js
// Tool pathway that handles cognitive search across various indexes
import { callPathway } from '../../../../lib/pathwayTools.js';
import logger from '../../../../lib/logger.js';
import { getSearchResultId } from '../../../../lib/util.js';

const INDEX_MAP = {
    'aja': 'idx-ucms-aja',
    'aje': 'idx-ucms-aje',
    'ajb': 'idx-ucms-ajb',
    'ajm': 'idx-ucms-ajm',
    'aj360': 'idx-ucms-aj360',
    'ajd': 'idx-ucms-ajd',
    'chinese': 'idx-ucms-chinese',
    'sanad': 'idx-ucms-sanad',
    'wires': 'idx-wires'
};
const VALID_INDEXES = Object.keys(INDEX_MAP);
const VALID_INDEXES_MESSAGE = VALID_INDEXES.join(', ');

export const resolveToolIndexName = ({ index, indexName } = {}) => {
    const logicalIndex = typeof index === 'string' ? index.toLowerCase() : '';
    if (logicalIndex) {
        return INDEX_MAP[logicalIndex] || '';
    }

    const suppliedIndexName = typeof indexName === 'string' ? indexName.trim() : '';
    if (!suppliedIndexName) return '';

    return INDEX_MAP[suppliedIndexName.toLowerCase()] || suppliedIndexName;
};

const SEARCH_PARAMS = {
    text: { type: "string", description: "Search query. Can be a phrase, '*' for all, or AI Search syntax." },
    query: { type: "string", description: "Alias for text. Use either text or query for the search string." },
    filter: { type: "string", description: "OData filter expression (e.g. 'date ge 2024-02-22T00:00:00Z')" },
    top: { type: "integer", description: "Number of results (default 50)" },
    titleOnly: { type: "boolean", description: "If true, return titles only without content" },
    userMessage: { type: "string", description: "User-friendly message describing what you're doing" }
};

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
            icon: "📰",
            function: {
                name: "SearchIndex",
                description: `Search Al Jazeera indexes: ${VALID_INDEXES_MESSAGE}. Use wires for news wires. ALWAYS use a date filter (last 3-7 days) for latest/recent queries. If results appear stale (years old on a daily source), re-query with a broader range before reporting.`,
                parameters: {
                    type: "object",
                    properties: {
                        index: {
                            type: "string",
                            enum: VALID_INDEXES,
                            description: `Index to search. Valid indexes: ${VALID_INDEXES_MESSAGE}. Use wires for news wires; there is no "news" index.`
                        },
                        ...SEARCH_PARAMS
                    },
                    required: ["index"]
                }
            }
        }
    ],

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const text = args.text || args.query || '';
        const { filter, top, titleOnly, stream, chatId, indexName, semanticConfiguration } = args;

        const removeVectorFields = (result) => {
            const { text_vector, image_vector, ...cleanResult } = result;
            return cleanResult;
        };

        const hasDateFilterError = (errorMessage) => {
            if (typeof errorMessage !== 'string') return false;
            return (
                (errorMessage.includes('unsupported data type') && errorMessage.includes('Date')) ||
                errorMessage.includes('date ge') ||
                errorMessage.includes('date filter')
            );
        };

        const getRecoveryMessage = (errorMessage, filter) => {
            if (hasDateFilterError(errorMessage) && filter) {
                return `The date filter format is incorrect. Azure Cognitive Search requires dates in ISO 8601 format with time (e.g., 'date ge 2025-11-25T00:00:00Z' instead of 'date ge 2025-11-25'). Please adjust the filter parameter and try again, or try without a date filter.`;
            }
            return "This tool failed. You can try again or try the backup tool for this function if one is available.";
        };

        const toolIndexName = resolveToolIndexName({ index: args.index, indexName });

        if (!toolIndexName) {
            throw new Error(`Invalid index: ${args.index}. Valid indexes: ${VALID_INDEXES_MESSAGE}. Use wires for news wires.`);
        }
        if (typeof text !== 'string' || text.trim() === '') {
            throw new Error("Parameter 'text' or alias 'query' is required and must be a non-empty string.");
        }

        try {
            const searchPathwayName = args.searchPathway || 'cognitive_search';
            const response = await callPathway(searchPathwayName, {
                ...args,
                text,
                filter,
                top: top || 50,
                titleOnly: titleOnly || false,
                indexName: toolIndexName,
                semanticConfiguration,
                stream: stream || false,
                chatId
            }, resolver);

            if (resolver.errors && resolver.errors.length > 0) {
                const errorMessages = Array.isArray(resolver.errors)
                    ? resolver.errors.map(err => err.message || err)
                    : [resolver.errors.message || resolver.errors];

                const errorMessageStr = errorMessages.join('; ');
                logger.error(`Cognitive search error for index ${toolIndexName}: ${errorMessageStr}`);
                return JSON.stringify({
                    error: errorMessageStr,
                    recoveryMessage: getRecoveryMessage(errorMessageStr, filter)
                });
            }

            if (!response) {
                const errorMessage = `No response received from cognitive search for index ${toolIndexName}`;
                logger.error(errorMessage);
                return JSON.stringify({
                    error: errorMessage,
                    recoveryMessage: getRecoveryMessage(errorMessage, filter)
                });
            }

            let parsedResponse;
            try {
                parsedResponse = JSON.parse(response);
            } catch (parseError) {
                const errorMessage = `Invalid response format from cognitive search: ${parseError.message}`;
                logger.error(`Failed to parse cognitive search response for index ${toolIndexName}: ${parseError.message}`);
                return JSON.stringify({
                    error: errorMessage,
                    recoveryMessage: getRecoveryMessage(errorMessage, filter)
                });
            }

            if (parsedResponse.error || parsedResponse.Error) {
                const errorMsg = parsedResponse.error?.message || parsedResponse.Error?.message ||
                               parsedResponse.error || parsedResponse.Error ||
                               'Unknown error from cognitive search';
                logger.error(`Cognitive search API error for index ${toolIndexName}: ${errorMsg}`);
                return JSON.stringify({
                    error: errorMsg,
                    recoveryMessage: getRecoveryMessage(errorMsg, filter)
                });
            }

            const combinedResults = [];

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
                combinedResults.push(...parsedResponse.value.map(result => ({
                    ...removeVectorFields(result),
                    searchResultId: getSearchResultId()
                })));
            }

            const answers = parsedResponse["@search.answers"];
            if (answers && Array.isArray(answers)) {
                combinedResults.push(...answers.map(ans => ({
                    searchResultId: getSearchResultId(),
                    title: "",
                    content: ans.text || "",
                    key: ans.key,
                    score: ans.score,
                    source_type: 'answer'
                })));
            }

            const { urlField, titleField, blobSasEnvVar } = args;
            if (urlField || titleField) {
                const urlSuffix = blobSasEnvVar ? (process.env[blobSasEnvVar] || '') : '';
                combinedResults.forEach(result => {
                    if (result.source_type === 'metadata' || result.source_type === 'answer') return;
                    if (urlField && result[urlField]) {
                        result.url = result[urlField] + urlSuffix;
                    }
                    if (titleField && result[titleField]) {
                        result.title = result[titleField];
                    }
                });
            }

            return JSON.stringify({ _type: "SearchResponse", value: combinedResults });
        } catch (e) {
            const errorMessage = e?.message || e?.toString() || String(e);
            logger.error(`Error in cognitive search for index ${toolIndexName}: ${errorMessage}`);
            return JSON.stringify({
                error: errorMessage,
                recoveryMessage: getRecoveryMessage(errorMessage, filter)
            });
        }
    }
};
