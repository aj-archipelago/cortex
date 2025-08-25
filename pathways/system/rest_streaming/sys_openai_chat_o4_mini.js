// sys_openai_chat_o4_mini.js

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
    model: 'oai-o4-mini',
    useInputChunking: false,
    emulateOpenAIChatModel: 'o4-mini',
    enableDuplicateRequests: false,
}