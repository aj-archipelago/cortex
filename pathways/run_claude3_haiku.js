// Text summarization module with custom resolver for turbo models
// This module exports a prompt that takes an input text and generates a summary using a custom resolver.

// Import required modules
import { Prompt } from '../server/prompt.js';

export default {
    // The main prompt function that takes the input text and asks to generate a summary.
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