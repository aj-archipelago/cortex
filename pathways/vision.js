import { Prompt } from '../server/prompt.js';

export default {
    prompt: [
        new Prompt({ messages: [
            "{{chatHistory}}",
        ]}),
    ],
    inputParameters: {
        chatHistory: [],
        contextId: ``,
    },
    max_tokens: 1024,
    model: 'oai-gpt4-vision',
    useInputChunking: false,
    enableDuplicateRequests: false,
}