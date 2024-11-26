import { setv, getv } from '../../../../lib/keyValueStorageClient.js';

export default {
    inputParameters: {
        contextId: ``,
        aiMemory: ``,
        section: `memoryAll`
    },
    model: 'oai-gpt4o',
    resolver: async (_parent, args, _contextValue, _info) => {
        const { contextId, aiMemory, section = 'memoryAll' } = args;

        // this code helps migrate old memory formats
        if (section === 'memoryLegacy') {
            let savedContext = (getv && (await getv(`${contextId}`))) || {};
            // if savedContext is not an object, set it to an empty object
            if (typeof savedContext !== 'object') {
                savedContext = {};
            }
            savedContext.memoryContext = aiMemory;
            await setv(`${contextId}`, savedContext);
            return aiMemory;
        }

        const validSections = ['memorySelf', 'memoryDirectives', 'memoryTopics', 'memoryUser'];

        // Handle single section save
        if (section !== 'memoryAll') {
            if (validSections.includes(section)) {
                await setv(`${contextId}-${section}`, aiMemory);
            }
            return aiMemory;
        }

        // if the aiMemory is an empty string, set all sections to empty strings
        if (aiMemory.trim() === "") {
            for (const section of validSections) {
                await setv(`${contextId}-${section}`, "");
            }
            return "";
        }
        
        // Handle multi-section save
        try {
            const memoryObject = JSON.parse(aiMemory);
            for (const section of validSections) {
                if (section in memoryObject) {
                    await setv(`${contextId}-${section}`, memoryObject[section]);
                }
            }
        } catch {
            for (const section of validSections) {
                await setv(`${contextId}-${section}`, "");
            }
            await setv(`${contextId}-memoryUser`, aiMemory);
        }

        return aiMemory;
    }
}