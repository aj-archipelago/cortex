// sys_openai_chat_gpt5.js
// override handler for gpt-5

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
    model: 'oai-gpt5',
    useInputChunking: false,
    emulateOpenAIChatModel: 'gpt-5',
    timeout: 900
} 