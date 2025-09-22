// sys_claude_37_sonnet.js
// override handler for claude-37-sonnet

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
        tools: '',
        tool_choice: 'auto',
    },
    model: 'claude-37-sonnet-vertex',
    useInputChunking: false,
    emulateOpenAIChatModel: 'claude-3.7-sonnet',
} 