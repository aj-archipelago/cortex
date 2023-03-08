// Description: Translate a text from one language to another

module.exports = {
    temperature: 0,
    prompt: `Translate the following text to {{to}}:\n\nOriginal Language:\n{{{text}}}\n\n{{to}}:\n`,
    inputParameters: {
        to: `Arabic`,
    },
    model: 'azure-td3',
    timeout: 300, // in seconds
}