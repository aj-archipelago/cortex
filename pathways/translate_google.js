// Description: Translate text using Google Cloud Translation API

export default {
    inputParameters: {
        from: 'auto', // Source language, 'auto' for automatic detection
        to: 'en',     // Target language
    },
    model: 'google-translate',
    timeout: 120,
}
