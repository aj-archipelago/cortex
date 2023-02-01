// Description: Translate a text from one language to another

module.exports = {
    temperature: 0,
    prompt:
        [
            `{{{text}}}\n\nList the names and places mentioned in this document in English:\n\n`,
            `Context: {{previousContext}}\n\nYou are a translator for an international news agency.  Your job is to translate partial documents to {{to}} as precisely as possible, ensuring that all proper nouns such as the names of people and places are translated exactly and correctly. All HTML and links in the partial document must also appear in the translation:\n\n[partial document]:\n{{{text}}}\n[translation to {{to}}]\n\n`,
        ],
    inputParameters: {
        to: `Arabic`,
    },
    model: 'azure-td2',
    usePreviousContext: true,
}