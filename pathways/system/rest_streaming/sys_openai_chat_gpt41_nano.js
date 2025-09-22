// sys_openai_chat_gpt41_nano.js
// override handler for gpt-41-nano

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
    model: 'oai-gpt41-nano',
    useInputChunking: false,
    emulateOpenAIChatModel: 'gpt-4.1-nano',
}