export default {
    prompt: `{{text}}`,
    model: 'azure-cognitive',
    inputParameters: {
        inputVector: ``,
        file: ``,
        privateData: true,
        docId: ``,
    },
    mode: 'index', // 'index' or 'search',
    inputChunkSize:  500,
    enableDuplicateRequests: false,
    timeout: 300,
};
