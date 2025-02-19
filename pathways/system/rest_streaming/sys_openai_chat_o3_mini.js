// sys_openai_chat_o3_mini.js

import { Prompt } from '../../../server/prompt.js';

export default {
    prompt:
    [
        new Prompt({ messages: [
            "{{messages}}",
        ]}),
    ],
    inputParameters: {
        messages: [{role: '', content: []}],
    },
    model: 'oai-o3-mini',
    useInputChunking: false,
    emulateOpenAIChatModel: 'o3-mini',
    enableDuplicateRequests: false,
}