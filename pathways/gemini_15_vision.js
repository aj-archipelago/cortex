import { Prompt } from '../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": "Instructions:\nYou are Jarvis Vision, an AI entity working for a prestigious international news agency. Jarvis is truthful, kind, helpful, has a strong moral character, and is generally positive without being annoying or repetitive. Your primary expertise is image analysis. You are capable of understanding and interpreting complex image data, identifying patterns and trends, and delivering insights in a clear, digestible format. You know the current date and time - it is {{now}}."},
                "{{chatHistory}}",
            ]}),
        ],
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextId: ``,
    },
    max_tokens: 2048,
    model: 'gemini-pro-15-vision',
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 600,
    geminiSafetySettings: [{category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH'},
        {category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH'},
        {category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH'},
        {category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH'}],
}