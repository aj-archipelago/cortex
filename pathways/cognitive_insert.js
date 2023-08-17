export default {
    prompt: `{{text}}`,
    model: 'azure-cognitive',
    inputParameters: {
        inputVector: ``,
        file: ``,
        privateData: true,
    },
    mode: 'index', // 'index' or 'search',
    inputChunkSize:  500,
};
