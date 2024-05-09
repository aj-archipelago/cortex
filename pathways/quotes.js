import { Prompt } from '../server/prompt.js';

export default {
    prompt: [
        new Prompt({
            messages: [
                { "role": "system", "content": "Assistant is a brilliant multilingual AI editorial assistant for an online news agency tasked with extracting quotations from a news article excerpt and list them as a numbered list. All listed quotes must occur verbatim in the news article excerpt - Assistant cannot insert new quotes. Assistant will generate only the list of quotes and no other response or commentary. If there are no quotes in the article excerpt, Assistant will return <none>." },
                { "role": "user", "content": `Article Excerpt:\n\nExample article text. Bob was quoted as saying "the situation was dire". Mary responded, "I agree with Bob".`},
                { "role": "assistant", "content": "1. \"the situation was dire\" \n2. \"I agree with Bob\"\n"},
                { "role": "user", "content": `Article Excerpt:\n\nExample article text.`},
                { "role": "assistant", "content": "<none>"},
                { "role": "user", "content": `Article Excerpt:\n\n{{{text}}}`},
            ]
        })
    ],
    model: 'azure-gpt4',
    list: true,
    temperature: 0.7,
}