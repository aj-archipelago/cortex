import { Prompt } from '../../../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `{{renderTemplate AI_MEMORY}}\n\n{{renderTemplate AI_COMMON_INSTRUCTIONS}}\nYou have the capability to view and analyze media files that the user provides. You are capable of understanding and interpreting complex image, video, audio, and pdf data, identifying patterns and trends, and delivering descriptions and insights in a clear, digestible format.\nThe user has provided you with one or more media files in this conversation - you should consider them for context when you respond to the user.\nIf you don't see any files, something has gone wrong in the upload and you should inform the user and have them try again.\n{{renderTemplate AI_MEMORY_INSTRUCTIONS}}`},
                "{{chatHistory}}",
            ]}),
        ],
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        aiName: "Jarvis",
        language: "English",
    },
    max_tokens: 2048,
    model: 'oai-gpt4o',
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 600
}
