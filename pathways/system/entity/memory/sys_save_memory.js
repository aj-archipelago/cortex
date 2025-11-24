import { getv } from '../../../../lib/keyValueStorageClient.js';
import { setvWithDoubleEncryption } from '../../../../lib/keyValueStorageClient.js';

export default {
    inputParameters: {
        contextId: ``,
        aiMemory: ``,
        section: `memoryAll`,
        contextKey: ``
    },
    model: 'oai-gpt4o',
    resolver: async (_parent, args, _contextValue, _info) => {
        const { contextId, aiMemory, section = 'memoryAll', contextKey } = args;

        // Validate that contextId is provided
        if (!contextId) {
            return JSON.stringify({ error: 'Context error' }, null, 2);
        }

        // this code helps migrate old memory formats
        if (section === 'memoryLegacy') {
            let savedContext = (getv && (await getv(`${contextId}`))) || {};
            // if savedContext is not an object, set it to an empty object
            if (typeof savedContext !== 'object') {
                savedContext = {};
            }
            savedContext.memoryContext = aiMemory;
            await setvWithDoubleEncryption(`${contextId}`, savedContext, contextKey);
            return aiMemory;
        }

        const validSections = ['memorySelf', 'memoryDirectives', 'memoryTopics', 'memoryUser', 'memoryVersion', 'memoryFiles'];
        // memoryFiles can only be accessed explicitly, not as part of memoryAll
        const allSections = ['memorySelf', 'memoryDirectives', 'memoryTopics', 'memoryUser', 'memoryVersion'];

        // Handle single section save
        if (section !== 'memoryAll') {
            if (validSections.includes(section)) {
                // memoryFiles should be JSON array, validate if provided
                if (section === 'memoryFiles' && aiMemory && aiMemory.trim() !== '') {
                    try {
                        // Validate it's valid JSON (but keep as string for storage)
                        JSON.parse(aiMemory);
                    } catch (e) {
                        // If not valid JSON, return error
                        return JSON.stringify({ error: 'memoryFiles must be a valid JSON array' });
                    }
                }
                await setvWithDoubleEncryption(`${contextId}-${section}`, aiMemory, contextKey);
            }
            return aiMemory;
        }

        // if the aiMemory is an empty string, set all sections (excluding memoryFiles) to empty strings
        if (aiMemory.trim() === "") {
            for (const section of allSections) {
                await setvWithDoubleEncryption(`${contextId}-${section}`, "", contextKey);
            }
            return "";
        }
        
        // Handle multi-section save (excluding memoryFiles)
        try {
            const memoryObject = JSON.parse(aiMemory);
            for (const section of allSections) {
                if (section in memoryObject) {
                    await setvWithDoubleEncryption(`${contextId}-${section}`, memoryObject[section], contextKey);
                }
            }
            // Explicitly ignore memoryFiles if present in the object
            if ('memoryFiles' in memoryObject) {
                // Silently ignore - memoryFiles can only be saved explicitly
            }
        } catch {
            for (const section of allSections) {
                await setvWithDoubleEncryption(`${contextId}-${section}`, "", contextKey);
            }
            await setvWithDoubleEncryption(`${contextId}-memoryUser`, aiMemory, contextKey);
        }

        return aiMemory;
    }
}