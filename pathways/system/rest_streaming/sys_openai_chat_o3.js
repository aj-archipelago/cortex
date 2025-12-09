// sys_openai_chat_o3.js

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
        functions: '',
        tools: '',
        tool_choice: 'auto',
    },
    model: 'oai-o3',
    useInputChunking: false,
    emulateOpenAIChatModel: 'o3',
    enableDuplicateRequests: false,
    timeout: 900
}