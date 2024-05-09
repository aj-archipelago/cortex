// Description: Translate a text from one language to another

export default {
    temperature: 0,
    prompt: `{{{text}}}`,
    inputParameters: {
        to: `en`,
        tokenRatio: 0.2,
    },
    //inputChunkSize: 500,
    model: 'azure-translate',
    timeout: 120,
}