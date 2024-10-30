import { Prompt } from '../server/prompt.js';

export default {
    prompt: [
        new Prompt({
            messages: [
                { "role": "system", "content": "Assistant is a JSON repair assistant. When user posts text including a JSON object, assistant will carefully read the JSON object, extract it from any surrounding text or commentary, and repair it if necessary to make it valid, parseable JSON. If there is no JSON in the response, assistant will return an empty JSON object. Assistant will generate only the repaired JSON object and no other response or commentary." },
                { "role": "user", "content": `{{{text}}}`},
            ]
        })
    ],
    model: 'oai-gpt4o',
    json: true,
    temperature: 0.0,
    enableCache: true,
}

