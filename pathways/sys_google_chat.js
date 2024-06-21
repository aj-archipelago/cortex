// sys_google_chat.js
// override handler for palm-chat

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
    model: 'palm-chat',
    useInputChunking: false,
    emulateOpenAIChatModel: 'palm-chat',
}