// sys_openai_chat_o1_mini.js

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
    model: 'oai-o1-mini',
    useInputChunking: false,
    emulateOpenAIChatModel: 'o1-mini',
    enableDuplicateRequests: false,
}