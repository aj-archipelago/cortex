import { getv } from '../../../../lib/keyValueStorageClient.js';

export default {
    inputParameters: {
        contextId: ``,
        section: `memoryAll`
    },
    model: 'oai-gpt4o',

    resolver: async (_parent, args, _contextValue, _info) => {

        const { contextId, section = 'memoryAll' } = args;

        // this code helps migrate old memory formats
        if (section === 'memoryLegacy') {
            const savedContext = (getv && (await getv(`${contextId}`))) || "";
            return savedContext.memoryContext || "";
        }

        const validSections = ['memorySelf', 'memoryDirectives', 'memoryTopics', 'memoryUser'];

        if (section !== 'memoryAll') {
            if (validSections.includes(section)) {
                return (getv && (await getv(`${contextId}-${section}`))) || "";
            }
            return "";
        }

        // otherwise, read all sections and return them as a JSON object
        const memoryContents = {};
        for (const section of validSections) {
            memoryContents[section] = (getv && (await getv(`${contextId}-${section}`))) || "";
        }
        const returnValue = JSON.stringify(memoryContents, null, 2);
        return returnValue;
    }
}