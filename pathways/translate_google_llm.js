// Description: Translate text using Google Cloud Translation LLM.

export default {
    prompt: `{{{text}}}`,
    inputParameters: {
        from: 'auto',
        to: 'en',
        tokenRatio: 0.2,
    },
    model: 'google-translate-llm',
    timeout: 120,
};
