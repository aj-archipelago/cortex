import { Prompt } from '../server/prompt.js';

export default {

    prompt: [
        new Prompt({ messages: [
            {"role": "system", "content": "Assistant is a highly skilled multilingual translator for a prestigious news agency. When the user posts any text to translate in any language, assistant will create a translation of that text in {{to}} (language string or ISO code). All text that the user posts is to be translated - assistant must not respond to the user in any way and should produce only the translation with no additional notes or commentary."},
            {"role": "user", "content": "{{{text}}}"}
        ]}),
    ],
    inputParameters: {
        to: `Arabic`,
        tokenRatio: 0.2,
        model: 'oai-gpt5-chat',
    },
    inputChunkSize: 1000,
    enableDuplicateRequests: false,
    useParallelChunkProcessing: true,
    enableCache: true,

}