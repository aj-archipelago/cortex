import { callPathway } from '../../../lib/pathwayTools.js';

export default {
    prompt:
        [],
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        aiName: "Jarvis",
        language: "English",
    },
    model: 'oai-gpt4o',
    useInputChunking: false,
    enableDuplicateRequests: false,
    executePathway: async ({args, resolver}) => {
        const styleModel = args.styleModel || resolver.pathway.model;
        const memoryContext = await callPathway('sys_search_memory', { ...args, section: 'memoryAll', updateContext: true });
        if (memoryContext) {
            args.chatHistory.splice(-1, 0, { role: 'assistant', content: memoryContext });
        }

        let result;
        if (args.voiceResponse) {
            result = await callPathway('sys_generator_quick', { ...args, model: styleModel, stream: false });
        } else {
            result = await callPathway('sys_generator_quick', { ...args, model: styleModel });
        }

        resolver.tool = JSON.stringify({ toolUsed: "memory" });
        return result;
    }
}
