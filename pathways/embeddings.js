// embeddings.js
// Embeddings module that returns the embeddings for the text. 

export default {
    prompt: `{{text}}`,
    model: 'azure-embeddings',
    enableCache: true,
    inputParameters: {
        input: [],
    },
    timeout: 300,
};

