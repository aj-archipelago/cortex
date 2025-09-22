// sys_openai_chat_gpt4_omni.js
// override handler for gpt-4-omni

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
    model: 'oai-gpt4o',
    useInputChunking: false,
    emulateOpenAIChatModel: 'gpt-4o',
}