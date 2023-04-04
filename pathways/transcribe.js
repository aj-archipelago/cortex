const transcribe = {
    prompt: `{{text}}`,
    model: `oai-whisper`,
    inputParameters: {
        file: ``,
    },
    timeout: 600, // in seconds
};

export default transcribe;
