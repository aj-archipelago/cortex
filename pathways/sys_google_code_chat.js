// sys_google_code_chat.js
// override handler for palm-code-chat

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
    model: 'palm-code-chat',
    useInputChunking: false,
    emulateOpenAIChatModel: 'palm-code-chat',
}