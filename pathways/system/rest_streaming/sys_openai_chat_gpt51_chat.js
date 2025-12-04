// sys_openai_chat_gpt51_chat.js

import { Prompt } from '../../../server/prompt.js';

export default {
    prompt:
        [
            new Prompt({
                messages: [
                    "{{messages}}",
                ]
            }),
        ],
    inputParameters: {
        messages: [{ role: '', content: [] }],
        tools: '',
        tool_choice: 'auto',
    },
    model: 'oai-gpt51-chat',
    useInputChunking: false,
    emulateOpenAIChatModel: 'gpt-5.1-chat',
    timeout: 900
}
