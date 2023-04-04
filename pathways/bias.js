// bias.js
// Objectivity analysis of text
// This module exports a prompt that analyzes the given text and determines if it's written objectively. It also provides a detailed explanation of the decision.

export default {
    // Uncomment the following line to enable caching for this prompt, if desired.
    // enableCache: true,
    
    prompt: `{{text}}\n\nIs the above text written objectively?  Why or why not, explain with details:\n`
};
