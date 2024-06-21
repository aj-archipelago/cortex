// sys_openai_chat_gpt4.js
// override handler for gpt-4

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
    model: 'oai-gpt4',
    useInputChunking: false,
    emulateOpenAIChatModel: 'gpt-4',
}