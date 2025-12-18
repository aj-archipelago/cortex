// this is a low-level system pathway that reads memory from the key-value store
// it should never try to call other pathways

import { getv } from '../../../../lib/keyValueStorageClient.js';
import { getvWithDoubleDecryption } from '../../../../lib/keyValueStorageClient.js';

const isValidISOTimestamp = (timestamp) => {
    if (!timestamp) return false;
    const date = new Date(timestamp);
    // Check if valid date and specifically in ISO format
    return !isNaN(date) && timestamp === date.toISOString();
};

const isValidPriority = (priority) => {
    // Must be a whole number
    const num = parseInt(priority);
    return !isNaN(num) && num.toString() === priority && num > 0;
};

export const processMemoryContent = (content, { priority = 0, recentHours = 0, numResults = 0, stripMetadata = false }) => {
    if (!content) return content;
    if (!priority && !recentHours && !numResults && !stripMetadata) return content;

    const lines = content.split('\n');
    const currentTime = Date.now();
    const cutoffTime = recentHours > 0 ? currentTime - (recentHours * 60 * 60 * 1000) : 0;
    
    // Create array of lines with their timestamps for sorting
    const processedLinesWithDates = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const parts = line.split('|');
        
        // Skip invalid lines
        if (!parts[0]) continue;
        
        // Priority check with strict validation
        if (priority > 0) {
            if (!isValidPriority(parts[0])) continue;
            const memoryPriority = parseInt(parts[0]);
            if (memoryPriority > priority) continue;
        }
        
        // Recency check with strict ISO validation
        if (recentHours > 0) {
            if (!isValidISOTimestamp(parts[1])) continue;
            const entryTime = new Date(parts[1]).getTime();
            if (entryTime < cutoffTime) continue;
        }
        
        // Store the line with its timestamp for sorting
        const timestamp = isValidISOTimestamp(parts[1]) ? new Date(parts[1]).getTime() : 0;
        
        // If stripMetadata is true, only keep the content part
        const processedLine = stripMetadata && parts.length >= 3 
            ? parts.slice(2).join('|')  // Strip metadata if requested and format is valid
            : line;                     // Keep original line otherwise
            
        processedLinesWithDates.push({ line: processedLine, timestamp });
    }
    
    // Sort by timestamp descending (newest first)
    processedLinesWithDates.sort((a, b) => b.timestamp - a.timestamp);
    
    // Take the top N results if specified
    const finalLines = numResults > 0
        ? processedLinesWithDates.slice(0, numResults)
        : processedLinesWithDates;
    
    // Extract just the lines and join them
    return finalLines.map(entry => entry.line).join('\n');
};

export default {
    inputParameters: {
        contextId: ``,
        section: `memoryAll`,
        priority: 0,
        recentHours: 0,
        numResults: 0,
        stripMetadata: false,
        contextKey: ``
    },
    model: 'oai-gpt4o',

    resolver: async (_parent, args, _contextValue, _info) => {
        const { contextId, section = 'memoryAll', priority = 0, recentHours = 0, numResults = 0, stripMetadata = false, contextKey } = args;
        
        // Validate that contextId is provided
        if (!contextId) {
            return JSON.stringify({ error: 'Context error' }, null, 2);
        }
        
        const options = { priority, recentHours, numResults, stripMetadata };

        // this code helps migrate old memory formats
        if (section === 'memoryLegacy') {
            const savedContext = (getv && (await getv(`${contextId}`))) || "";
            return savedContext.memoryContext || "";
        }

        const validSections = ['memorySelf', 'memoryDirectives', 'memoryTopics', 'memoryUser', 'memoryContext', 'memoryVersion'];
        const allSections = ['memorySelf', 'memoryDirectives', 'memoryTopics', 'memoryUser', 'memoryContext', 'memoryVersion'];

        if (section !== 'memoryAll') {
            if (validSections.includes(section)) {
                const content = (getvWithDoubleDecryption && (await getvWithDoubleDecryption(`${contextId}-${section}`, contextKey))) || "";
                return processMemoryContent(content, options);
            }
            return "";
        }

        // otherwise, read all sections and return them as a JSON object
        const memoryContents = {};
        for (const section of allSections) {
            if (section === 'memoryContext') continue;

            const content = (getvWithDoubleDecryption && (await getvWithDoubleDecryption(`${contextId}-${section}`, contextKey))) || "";
            memoryContents[section] = processMemoryContent(content, options);
        }
        
        return JSON.stringify(memoryContents, null, 2);
    }
}