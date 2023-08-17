// embeddings.js
// Embeddings module that returns the embeddings for the text. 

export default {
    prompt: `{{text}}`,
    model: 'oai-embeddings',
    enableCache: true,
    inputParameters: {
        input: [],
    },
};

