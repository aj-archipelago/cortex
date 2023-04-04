// edit.js
// Grammar and spelling correction module
// This module exports a prompt that takes an input text and corrects all spelling and grammar errors found within the text.

export default {
    // Set the temperature to 0 to favor more deterministic output when generating corrections.
    temperature: 0,

    prompt: `Correct all spelling and grammar errors in the input text.\n\nInput:\n{{text}}\n\nOutput:\n`
};

