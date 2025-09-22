// sys_grok_4_fast_non_reasoning.js
// override handler for grok-4-fast-non-reasoning

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
    model: 'xai-grok-4-fast-non-reasoning',
    useInputChunking: false,
    emulateOpenAIChatModel: 'grok-4-fast-non-reasoning'
}
