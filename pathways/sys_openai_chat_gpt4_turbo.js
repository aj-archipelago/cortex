// sys_openai_chat_gpt4_turbo.js
// override handler for gpt-4-turbo

import { Prompt } from '../server/prompt.js';

export default {
    prompt:
    [
        new Prompt({ messages: [
            "{{messages}}",
        ]}),
    ],
    inputParameters: {
        messages: [],
    },
    model: 'oai-gpt4-turbo',
    useInputChunking: false,
    emulateOpenAIChatModel: 'gpt-4-turbo',
}