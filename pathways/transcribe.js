export default {
    prompt: `{{text}}`,
    model: `oai-whisper`,
    inputParameters: {
        file: ``,
        language: ``,
        responseFormat: `text`,
        wordTimestamped: false,
        highlightWords: false,
        maxLineWidth: 0,
        maxLineCount: 0,
        maxWordsPerLine: 0,
    },
    timeout: 3600, // in seconds
    enableDuplicateRequests: false,
};