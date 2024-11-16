// sys_openai_chat_gpt4_32.js
// override handler for gpt-4-32

import { Prompt } from '../../../server/prompt.js';

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
    model: 'oai-gpt4-32',
    useInputChunking: false,
    emulateOpenAIChatModel: 'gpt-4-32k',
}