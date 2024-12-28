import { getv } from '../../../../lib/keyValueStorageClient.js';

const filterByPriority = (content, priority) => {
    if (!priority || !content) return content;
    
    const lines = content.split('\n');
    const filteredLines = lines.filter(line => {
        const match = line.match(/^\s*\[P(\d+)\]/);
        if (!match) return false;
        const memoryPriority = parseInt(match[1]);
        return memoryPriority <= priority;
    });
    
    return filteredLines.join('\n');
};

export default {
    inputParameters: {
        contextId: ``,
        section: `memoryAll`,
        priority: 0
    },
    model: 'oai-gpt4o',

    resolver: async (_parent, args, _contextValue, _info) => {

        const { contextId, section = 'memoryAll', priority = 0 } = args;

        // this code helps migrate old memory formats
        if (section === 'memoryLegacy') {
            const savedContext = (getv && (await getv(`${contextId}`))) || "";
            return savedContext.memoryContext || "";
        }

        const validSections = ['memorySelf', 'memoryDirectives', 'memoryTopics', 'memoryUser'];

        if (section !== 'memoryAll') {
            if (validSections.includes(section)) {
                const content = (getv && (await getv(`${contextId}-${section}`))) || "";
                return filterByPriority(content, priority);
            }
            return "";
        }

        // otherwise, read all sections and return them as a JSON object
        const memoryContents = {};
        for (const section of validSections) {
            const content = (getv && (await getv(`${contextId}-${section}`))) || "";
            memoryContents[section] = filterByPriority(content, priority);
        }
        const returnValue = JSON.stringify(memoryContents, null, 2);
        return returnValue;
    }
}