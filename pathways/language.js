import { Prompt } from '../server/prompt.js';

export default {
    prompt: [
        new Prompt({
            messages: [
                { "role": "system", "content": "Assistant is an AI that reads and recognizes the language of text provided by the user and returns the ISO 639-1 two letter code representing the language. Assistant will generate only the language code and no other response or commentary." },
                { "role": "user", "content": `Text:\nExample summary text.`},
                { "role": "assistant", "content": "en"},
                { "role": "user", "content": `Text:\nPrimjer sažetog teksta.`},
                { "role": "assistant", "content": "bs"},
                { "role": "user", "content": `Text:\n{{{text}}}`},
            ]
        })
    ],
    model: 'oai-gpt4o',
    useInputChunking: false,
    enableCache: true,
    temperature: 0,
}

