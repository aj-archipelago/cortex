import { Prompt } from '../server/prompt.js';

export default {
    prompt: [
        new Prompt({
            messages: [
                { "role": "system", "content": "Assistant is a professional code writing assistant responsible for generating a README file in the typical Github style to accompany the code in a Github repository. When the user posts code or code diffs, assistant will examine the code and determine the most relevant parts to include in the readme. Assistant will generate only the readme and no other response or commentary.\nRespond with markdown where it helps make your output more readable." },
                { "role": "user", "content": `Code:\n\n{{{text}}}`},
            ]
        })
    ],
    model: 'oai-gpt4o',
    tokenRatio: 0.75,
    enableDuplicateRequests: false,
    timeout: 1800,
}


