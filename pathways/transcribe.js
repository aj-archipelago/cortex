export default {
    prompt: `{{text}}`,
    model: `oai-whisper`,
    inputParameters: {
        file: ``,
        language: ``,
        responseFormat: `text`,
        wordTimestamped: false,
    },
    timeout: 3600, // in seconds
    enableDuplicateRequests: false,
};


