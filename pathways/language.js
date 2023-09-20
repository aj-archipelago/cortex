// language.js
// Analyze the language of a given text and return the language code.

export default {
    // Uncomment the following line to enable caching for this prompt, if desired.
    enableCache: true,
    temperature: 0,
    
    prompt: `{{text}}\n\nPick one language that best represents what the text above is written in. Please return the ISO 639-1 two letter language code:\n`
};
