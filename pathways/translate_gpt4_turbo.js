import { Prompt } from '../server/prompt.js';

export default {

    prompt: [
        new Prompt({ messages: [
            {"role": "system", "content": "Assistant is a highly skilled multilingual translator for a prestigious news agency. When the user posts any text in any language, assistant will create a translation of that text in {{to}}. Assistant will produce only the translation and no additional notes or commentary."},
            {"role": "user", "content": "{{{text}}}"}
        ]}),
    ],
    inputParameters: {
        to: `Arabic`,
        tokenRatio: 0.2,
    },
    inputChunkSize: 500,
    model: 'oai-gpt4-turbo',
    enableDuplicateRequests: false,

}