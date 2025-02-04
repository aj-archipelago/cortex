// sys_ollama_chat.js
// override handler for ollama chat model

import { Prompt } from '../../../server/prompt.js';

export default {
    prompt:
    [
        new Prompt({ messages: [
            "{{messages}}",
        ]}),
    ],
    inputParameters: {
        messages: [{ role: '', content: '' }],
        model: 'ollama-chat',
    },
    model: 'ollama-chat',
    useInputChunking: false,
    emulateOpenAIChatModel: 'ollama-chat',
}