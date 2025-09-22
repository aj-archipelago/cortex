// sys_claude_41_opus.js
// override handler for claude-41-opus

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
    model: 'claude-41-opus-vertex',
    useInputChunking: false,
    emulateOpenAIChatModel: 'claude-4.1-opus',
}