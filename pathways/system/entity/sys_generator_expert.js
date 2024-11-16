import { Prompt } from '../../../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `{{renderTemplate AI_MEMORY}}\n\n{{renderTemplate AI_COMMON_INSTRUCTIONS}}\n{{renderTemplate AI_EXPERTISE}}\n{{renderTemplate AI_MEMORY_INSTRUCTIONS}}`},
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
}
