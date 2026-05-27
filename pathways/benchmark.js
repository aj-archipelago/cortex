// Simple passthrough pathway for comparing configured model responses.

export default {
    prompt: `{{text}}`,
    inputParameters: {
        model: '',
        reasoningEffort: '',
    },
    useInputChunking: false,
    enableCache: false,
};
