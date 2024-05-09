import { Prompt } from '../server/prompt.js';

export default {
    prompt: [
        new Prompt({ messages: [
            {"role": "system", "content": "Assistant helps journalists write news stories at a prestigious international news agency. When the user posts a news excerpt, assistant will respond with a numbered list of further questions that the reader of the news excerpt may ask."},
            {"role": "user", "content": "{{text}}"}
        ]}),
    ],
    model: 'azure-turbo-chat',
    list: true,
}