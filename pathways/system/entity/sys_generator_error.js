import { Prompt } from '../../../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `{{renderTemplate AI_COMMON_INSTRUCTIONS}}\n\nThe user has requested information that you have already determined can be found in the indexes that you can search, and you were trying to search for it, but encountered the following error: {{{text}}}. Your response should be very short, fit the rest of the conversation, and be appropriate for the context. You cannot resolve this error.`},
                "{{chatHistory}}",
            ]}),
        ],
    inputParameters: {
        chatHistory: [],
        contextId: ``,
        text: '',
        aiName: "Jarvis",
        language: "English",
    },
    model: 'oai-gpt4o',
    useInputChunking: false,
}