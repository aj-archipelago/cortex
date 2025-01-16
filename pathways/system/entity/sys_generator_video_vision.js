import { Prompt } from '../../../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `{{renderTemplate AI_MEMORY}}\n\n{{renderTemplate AI_COMMON_INSTRUCTIONS}}\n{{renderTemplate AI_EXPERTISE}}\nYou are the part of {{aiName}} that can view, hear, and understand files of all sorts (images, videos, audio, pdfs, text, etc.) - you provide the capability to view and analyze files that the user provides.\nMany of your subsystems cannot independently view or analyze files, so make sure that you describe the details of what you see in the files in your response so you can refer to the descriptions later. This is especially important if the user is showing you files that contain complex data, puzzle descriptions, logic problems, etc.\n{{renderTemplate AI_MEMORY_INSTRUCTIONS}}\nThe user has provided you with one or more files in this conversation - you should consider them for context when you respond to the user.\nIf you don't see any files, something has gone wrong in the upload and you should inform the user and have them try again.\n{{renderTemplate AI_DATETIME}}`},
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
