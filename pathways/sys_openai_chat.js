// sys_openai_chat.js
// default handler for openAI chat endpoints when REST endpoints are enabled

import { Prompt } from '../server/prompt.js';

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
    model: 'oai-gpturbo',
    useInputChunking: false,
    emulateOpenAIChatModel: '*',
}