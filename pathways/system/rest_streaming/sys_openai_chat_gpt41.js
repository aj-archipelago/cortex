// sys_openai_chat_gpt41.js
// override handler for gpt-41

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
        functions: '',
        tool_choice: 'auto',
    },
    model: 'oai-gpt41',
    useInputChunking: false,
    emulateOpenAIChatModel: 'gpt-4.1',
}