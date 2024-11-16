import { Prompt } from '../../../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({ messages: [
                {"role": "system", "content": `{{renderTemplate AI_MEMORY}}\n\n{{renderTemplate AI_COMMON_INSTRUCTIONS_VOICE}}\n{{renderTemplate AI_MEMORY_INSTRUCTIONS}}`},
                "{{chatHistory}}",
            ]}),
        ],
    inputParameters: {
        chatHistory: [],
        contextId: ``,
        aiName: "Jarvis",
        language: "English",
        model: "oai-gpt4o",
    },
    useInputChunking: false,
    enableDuplicateRequests: false
}
