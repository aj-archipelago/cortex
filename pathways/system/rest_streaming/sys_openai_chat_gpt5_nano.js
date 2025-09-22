// sys_openai_chat_gpt5_nano.js
// override handler for gpt-5-nano

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
    model: 'oai-gpt5-nano',
    useInputChunking: false,
    emulateOpenAIChatModel: 'gpt-5-nano',
} 