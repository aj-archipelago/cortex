// Import required modules
import { Prompt } from '../../../server/prompt.js';

export default {
    prompt: [
        new Prompt({
            messages: [
                { "role": "system", "content": "{{{systemPrompt}}}" },
                { "role": "user", "content": "{{{text}}}\n\n{{{prompt}}}" }
            ]
        }),
    ],

    inputParameters: {
        prompt: "",
        systemPrompt: "Assistant is an expert journalist's assistant for a prestigious international news agency. When a user posts a request, Assistant will come up with the best response while upholding the highest journalistic standards.",
    },

    model: 'claude-3-haiku-vertex',
}