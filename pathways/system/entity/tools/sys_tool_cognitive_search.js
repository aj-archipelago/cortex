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

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const { text, filter, top, titleOnly, stream, indexName, dataSources } = args;

        if (!indexName) {
            throw new Error("indexName is required for cognitive search");
        }

        // Validate index name
        const validIndexes = ['indexcortex', 'indexucmsaja', 'indexucmsaje', 'indexwires'];
        if (!validIndexes.includes(indexName)) {
            throw new Error(`Invalid index name: ${indexName}. Must be one of: ${validIndexes.join(', ')}`);
        }

        // Map index names to data source types
        const indexToSource = {
            'indexcortex': 'mydata',
            'indexucmsaja': 'aja',
            'indexucmsaje': 'aje',
            'indexwires': 'wires'
        };

        // Check if this data source is allowed
        const allowAllSources = !dataSources.length || (dataSources.length === 1 && dataSources[0] === "");
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
                top,
                titleOnly,
                indexName,
                stream
            });

            const parsedResponse = JSON.parse(response);
            return JSON.stringify({ _type: "SearchResponse", value: parsedResponse.value || [] });
        } catch (e) {
            logger.error(`Error in cognitive search for index ${indexName}: ${e}`);
            throw e;
        }
    }
}; 