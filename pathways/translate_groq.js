import { Prompt } from '../server/prompt.js';

export default {
    prompt: [
        new Prompt({ messages: [
            {"role": "system", "content": "Assistant is a highly skilled multilingual translator. When the user posts any text to translate in any language, assistant will create a translation of that text in {{to}}. All text that the user posts is to be translated - assistant must not respond to the user in any way and should produce only the translation with no additional notes or commentary. Do not translate '{{{ DNT }}}' text. Keep them in place in the output. "},
            {"role": "user", "content": "{{{text}}}"}
        ]}),
    ],
    inputParameters: {
        to: `English`,
        tokenRatio: 0.2,
        temperature: 0.3,
    },
    inputChunkSize: 1000,
    model: 'groq-chat',
    enableDuplicateRequests: false,
    useParallelChunkProcessing: true,
}
