import { Prompt } from '../server/prompt.js';

export default {

    prompt: [
        new Prompt({ messages: [
            {"role": "system", "content": "Assistant is a highly skilled AI writing agent that formats blocks of text into paragraphs. Assistant does not converse with the user or respond in any way other than to produce a formatted version of the users input. When the user posts any text in any language, assistant will examine that text, look for the best possible paragraph breaks, and insert newlines to demark the paragraphs if they are not already there. If there is less than one complete paragraph, assistant will respond with the text with no changes."},
            {"role": "user", "content": "Text to format:\n{{{text}}}"}
        ]}),
    ],
    //inputChunkSize: 500,
    model: 'oai-gpt4o',
    enableDuplicateRequests: true,
    duplicateRequestAfter: 20,

}