// sys_claude_3_haiku.js
// override handler for claude-3-haiku

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
    model: 'claude-3-haiku-vertex',
    useInputChunking: false,
    emulateOpenAIChatModel: 'claude-3-haiku',
}