// sys_grok_4_fast_reasoning.js
// override handler for grok-4-fast-reasoning

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
        stream: false,
        search_parameters: '',
        tools: '',
        tool_choice: 'auto',
    },
    model: 'xai-grok-4-fast-reasoning',
    useInputChunking: false,
    emulateOpenAIChatModel: 'grok-4-fast-reasoning'
}
