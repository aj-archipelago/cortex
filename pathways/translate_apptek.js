// Description: Translate text using AppTek's translation service

export default {
    inputParameters: {
        from: 'auto', // Source language, 'auto' for automatic detection
        to: 'en',     // Target language
    },
    model: 'apptek-translate',
    timeout: 120,
}
