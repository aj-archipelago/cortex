// sys_grok_chat.js
// override handler for grok-4 and grok-3

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
    model: 'xai-grok-4',
    useInputChunking: false,
    emulateOpenAIChatModel: 'grok-4',
} 