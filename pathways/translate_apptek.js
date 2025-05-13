// Description: Translate text using AppTek's translation service

export default {
    inputParameters: {
        from: 'auto', // Source language, 'auto' for automatic detection
        to: 'en',     // Target language
        glossaryId: 'none', // Optional glossary ID
    },
    model: 'apptek-translate',
    timeout: 120,
}
