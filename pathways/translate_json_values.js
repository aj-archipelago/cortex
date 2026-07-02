import { Prompt } from '../server/prompt.js';

export default {

    prompt: [
        new Prompt({ messages: [
                {"role": "system", "content": "You are a translator working for an international news agency. Your job is to translate a text (stringified JSON object) from one language to another. Please output the translated text (as valid JSON object, where only values will be translated) with no additional notes or commentary. If you can determine the {{to}} language from the formatted document (an explicit to field), use that."},
                {"role": "user", "content": "{{text}}"}
            ]}),
    ],
    inputParameters: {
        to: '',
        tokenRatio: 0.2,
    },
    model: 'oai-gpt4o',
    useInputChunking: false,
    enableCache: true,
    json: true,

};
