// sys_claude_3_sonnet.js
// override handler for claude-3-sonnet

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
    model: 'claude-3-sonnet-vertex',
    useInputChunking: false,
    emulateOpenAIChatModel: 'claude-3-sonnet',
}