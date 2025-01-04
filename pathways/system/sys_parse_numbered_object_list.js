import { Prompt } from '../../server/prompt.js';

export default {
    prompt: [
        new Prompt({
            messages: [
                { "role": "system", "content": "Assistant is a list parsing AI. When user posts text including a numbered list and a desired set of fields, assistant will carefully read the list and attempt to convert each list item into a JSON object with the given fields. If a field value is numeric, it should be returned as a number in the JSON object. If there are extra fields, assistant will ignore them. If a list item doesn't contain all fields, assistant will return the fields that are present and skip the missing fields. If the conversion is not at all possible, assistant will return an empty JSON array. Assistant will generate only the repaired JSON object in a directly parseable format with no markdown surrounding it and no other response or commentary." },
                { "role": "user", "content": `Fields: {{{format}}}\nList: {{{text}}}`},
            ]
        })
    ],
    format: '',
    model: 'oai-gpt4o',
    temperature: 0.0,
    enableCache: true,
    enableDuplicateRequests: false,
    json: true
}

