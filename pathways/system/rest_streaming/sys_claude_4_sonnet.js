// sys_claude_4_sonnet.js
// override handler for claude-4-sonnet

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
    model: 'claude-4-sonnet-vertex',
    useInputChunking: false,
    emulateOpenAIChatModel: 'claude-4-sonnet',
}