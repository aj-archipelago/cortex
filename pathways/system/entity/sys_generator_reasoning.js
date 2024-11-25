import { Prompt } from '../../../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `{{renderTemplate AI_COMMON_INSTRUCTIONS}}\n{{renderTemplate AI_EXPERTISE}}\n{{renderTemplate AI_DIRECTIVES}}\nUse all of the information in your memory and the chat history to reason about the user's request and provide a response. Often this information will be more current than your knowledge cutoff.`},
                "{{chatHistory}}",
            ]}),
        ],
    inputParameters: {
        chatHistory: [],
        contextId: ``,
        aiName: "Jarvis",
        language: "English",
    },
    model: 'oai-o1-mini',
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 600,
    executePathway: async ({args, runAllPrompts, resolver}) => {
        const result = await runAllPrompts({ ...args });
        resolver.tool = JSON.stringify({ toolUsed: "reasoning" });
        return result;
    }
        
}
