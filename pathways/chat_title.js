import { Prompt } from '../server/prompt.js';

export default {
    prompt: [
        new Prompt({
            messages: [
                {
                    role: "system",
                    content: `You are an AI that picks a perfect short title to be displayed in a UI to represent the content of a given chat. Evaluate and update the chat title if needed. If the current title is appropriate for the chat history, return it unchanged.  If an update is necessary, provide a revised title. Consider the most recent text in your assessment. The title must be no more than 25 characters. Return only the title.`,
                },
                {
                    role: "user",
                    content: `<CHAT_HISTORY>\n{{{toJSON chatHistory}}}\n</CHAT_HISTORY>\nExisting Chat Title: {{title}}`,
                },
            ],
        }),
    ],
    inputParameters: {
        title: '',
        text: '',
    },
    model: 'oai-gpt4o',
    useInputChunking: false,
    temperature: 0,
    enableDuplicateRequests: false
};