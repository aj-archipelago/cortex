// translate.js
// Translation module
// This module exports a prompt that takes an input text and translates it from one language to another.

export default {
    // Set the temperature to 0 to favor more deterministic output when generating translations.
    temperature: 0,

    prompt: `Translate the following text to {{to}}:\n\nOriginal Language:\n{{{text}}}\n\n{{to}}:\n`,

    // Define input parameters for the prompt, such as the target language for translation.
    inputParameters: {
        to: `Arabic`,
    },

    // Set the timeout for the translation process, in seconds.
    timeout: 300,
    inputChunkSize: 500,
};

