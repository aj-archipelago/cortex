// sys_openai_chat.js
// override handler for gpt-3.5-turbo

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
    model: 'oai-gpturbo',
    useInputChunking: false,
    emulateOpenAIChatModel: 'gpt-3.5-turbo',
}