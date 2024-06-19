export default {
    prompt: `{{text}}`,
    model: 'azure-cognitive',
    inputParameters: {
        calculateInputVector: false,
        indexName: ``,
        inputVector: ``,
        file: ``,
        privateData: true,
        docId: ``,
        chatId: ``,
    },
    mode: 'index', // 'index' or 'search',
    inputChunkSize:  500,
    enableDuplicateRequests: false,
    timeout: 3000,
};
