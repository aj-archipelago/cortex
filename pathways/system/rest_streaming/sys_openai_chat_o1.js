// sys_openai_chat_o1.js

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
    model: 'oai-o1',
    useInputChunking: false,
    emulateOpenAIChatModel: 'o1',
    enableDuplicateRequests: false,
}