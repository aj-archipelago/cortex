// sys_openai_chat_gpt51.js

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
    model: 'oai-gpt51',
    useInputChunking: false,
    emulateOpenAIChatModel: 'gpt-5.1',
    timeout: 900
}
