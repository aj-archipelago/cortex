// sys_google_gemini_25_pro.js
// override handler for gemini-pro-25-vision

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
    model: 'gemini-pro-25-vision',
    useInputChunking: false,
    emulateOpenAIChatModel: 'gemini-pro-25',
    geminiSafetySettings: [{category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH'},
                            {category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH'},
                            {category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH'},
                            {category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH'}],
}