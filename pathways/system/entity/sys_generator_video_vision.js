import { Prompt } from '../../../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `{{renderTemplate AI_COMMON_INSTRUCTIONS}}\n{{renderTemplate AI_EXPERTISE}}\n{{renderTemplate AI_DIRECTIVES}}\nYou have the capability to view and analyze media files that the user provides. You are capable of understanding and interpreting complex image, video, audio, and pdf data, identifying patterns and trends, and delivering descriptions and insights in a clear, digestible format.\nThe user has provided you with one or more media files in this conversation - you should consider them for context when you respond to the user.\nIf you don't see any files, something has gone wrong in the upload and you should inform the user and have them try again.`},
                "{{chatHistory}}",
            ]}),
        ],
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        aiName: "Jarvis",
        language: "English",
    },
    max_tokens: 4096,
    model: 'oai-gpt4o',
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 600,
    executePathway: async ({args, runAllPrompts, resolver}) => {
        const result = await runAllPrompts({ ...args });
        resolver.tool = JSON.stringify({ toolUsed: "vision" });
        return result;
    }
}
