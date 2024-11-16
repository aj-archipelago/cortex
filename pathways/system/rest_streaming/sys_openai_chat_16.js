// sys_openai_chat_16.js
// override handler for gpt-3.5-turbo-16k

import { Prompt } from '../../../server/prompt.js';

export default {
    prompt:
    [
        new Prompt({ messages: [
            "{{messages}}",
        ]}),
    ],
    inputParameters: {
        messages: [],
    },
    model: 'azure-turbo-16',
    useInputChunking: false,
    emulateOpenAIChatModel: 'gpt-3.5-turbo-16k',
}