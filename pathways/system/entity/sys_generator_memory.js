import { callPathway } from '../../../lib/pathwayTools.js';
import { insertToolCallAndResults } from './memory/shared/sys_memory_helpers.js';

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

        const { aiStyle, AI_STYLE_ANTHROPIC, AI_STYLE_OPENAI } = args;
        const styleModel = aiStyle === "Anthropic" ? AI_STYLE_ANTHROPIC : AI_STYLE_OPENAI;

        const memoryContext = await callPathway('sys_search_memory', { ...args, stream: false, section: 'memoryAll', updateContext: true });
        if (memoryContext) {
            insertToolCallAndResults(args.chatHistory, "search memory for relevant information", "memory_lookup", memoryContext);
        }

        let result;
        if (args.voiceResponse) {
            result = await callPathway('sys_generator_quick', { ...args, model: styleModel, stream: false }, resolver);
        } else {
            result = await callPathway('sys_generator_quick', { ...args, model: styleModel }, resolver);
        }

        resolver.tool = JSON.stringify({ toolUsed: "memory" });
        return result;
    }
}
