import { Prompt } from '../../server/prompt.js';

export default {
    prompt: [
        new Prompt({
            messages: [
                { "role": "system", "content": "Assistant is a list parsing AI. When user posts text including a numbered list and a desired set of fields, assistant will carefully read the list and attempt to convert the list into a JSON array named 'list' of objects. Each list item is converted into an array element object with the given fields. If a field value is numeric, it should be returned as a number in the object. If there are extra fields, assistant will ignore them. If a list item doesn't contain all fields, assistant will return the fields that are present and skip the missing fields. If the conversion is not at all possible, assistant will return an empty JSON array {list:[]}.\n\nExample: {list:[{field1: \"value1\", field2: \"value2\"}, {field1: \"value3\", field2: \"value4\"}]}"},
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

