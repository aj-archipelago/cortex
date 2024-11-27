// sys_claude_35_sonnet.js
// override handler for claude-35-sonnet

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
    model: 'claude-35-sonnet-vertex',
    useInputChunking: false,
    emulateOpenAIChatModel: 'claude-3.5-sonnet',
}