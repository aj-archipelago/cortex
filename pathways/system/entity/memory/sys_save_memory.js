import { setv, getv } from '../../../../lib/keyValueStorageClient.js';
import { setvWithDoubleEncryption } from '../../../../lib/doubleEncryptionStorageClient.js';
import { config } from '../../../../config.js';

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
            return JSON.stringify({ error: 'Authentication error' }, null, 2);
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

        const validSections = ['memorySelf', 'memoryDirectives', 'memoryTopics', 'memoryUser', 'memoryVersion'];

        // Handle single section save
        if (section !== 'memoryAll') {
            if (validSections.includes(section)) {
                await setvWithDoubleEncryption(`${contextId}-${section}`, aiMemory, contextKey);
            }
            return aiMemory;
        }

        // if the aiMemory is an empty string, set all sections to empty strings
        if (aiMemory.trim() === "") {
            for (const section of validSections) {
                await setvWithDoubleEncryption(`${contextId}-${section}`, "", contextKey);
            }
            return "";
        }
        
        // Handle multi-section save
        try {
            const memoryObject = JSON.parse(aiMemory);
            for (const section of validSections) {
                if (section in memoryObject) {
                    await setvWithDoubleEncryption(`${contextId}-${section}`, memoryObject[section], contextKey);
                }
            }
        } catch {
            for (const section of validSections) {
                await setvWithDoubleEncryption(`${contextId}-${section}`, "", contextKey);
            }
            await setvWithDoubleEncryption(`${contextId}-memoryUser`, aiMemory, contextKey);
        }

        return aiMemory;
    }
}