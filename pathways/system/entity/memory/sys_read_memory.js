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

const filterByRecent = (content, recentHours) => {
    if (!recentHours || !content) return content;

    const lines = content.split('\n');
    const currentTime = Date.now();
    const cutoffTime = currentTime - (recentHours * 60 * 60 * 1000);
    
    // Walk backwards through lines until we hit an old entry
    const filteredLines = [];
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        const dateMatch = line.match(/\[P\d+\]\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/);
        if (!dateMatch) continue;
        
        const timestamp = new Date(dateMatch[1]).getTime();
        if (timestamp < cutoffTime) break; // Stop processing once we hit old entries
        
        filteredLines.unshift(line); // Add to front to maintain original order
    }

    return filteredLines.join('\n');
};

export default {
    inputParameters: {
        contextId: ``,
        section: `memoryAll`,
        priority: 0,
        recentHours: 0
    },
    model: 'oai-gpt4o',

    resolver: async (_parent, args, _contextValue, _info) => {
        const { contextId, section = 'memoryAll', priority = 0, recentHours = 0 } = args;

        // this code helps migrate old memory formats
        if (section === 'memoryLegacy') {
            const savedContext = (getv && (await getv(`${contextId}`))) || "";
            return savedContext.memoryContext || "";
        }

        const validSections = ['memorySelf', 'memoryDirectives', 'memoryTopics', 'memoryUser'];

        if (section !== 'memoryAll') {
            if (validSections.includes(section)) {
                let content = (getv && (await getv(`${contextId}-${section}`))) || "";
                
                // Apply filters based on section and parameters
                if (priority > 0) {
                    content = filterByPriority(content, priority);
                }
                
                // Only apply recency filter to memoryTopics
                if (section === 'memoryTopics' && recentHours > 0) {
                    content = filterByRecent(content, recentHours);
                }
                
                return content;
            }
            return "";
        }

        // otherwise, read all sections and return them as a JSON object
        const memoryContents = {};
        for (const section of validSections) {
            let content = (getv && (await getv(`${contextId}-${section}`))) || "";
            
            if (priority > 0) {
                content = filterByPriority(content, priority);
            }
            
            // Only apply recency filter to memoryTopics
            if (section === 'memoryTopics' && recentHours > 0) {
                content = filterByRecent(content, recentHours);
            }
            
            memoryContents[section] = content;
        }
        const returnValue = JSON.stringify(memoryContents, null, 2);
        return returnValue;
    }
}