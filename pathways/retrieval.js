import { Prompt } from '../server/prompt.js';

// Description: Have a chat with a bot that uses context to understand the conversation + extension for Azure
export default {
    prompt:
        [
            new Prompt({ messages: [
                "{{chatHistory}}",
            ]}),
        ],
    // prompt: `{{text}}`,
    inputParameters: {
        chatHistory: [],
        contextId: ``,
        indexName: ``,
        roleInformation: ``,
    },
    model: `azure-extension`,
    useInputChunking: false,
}

