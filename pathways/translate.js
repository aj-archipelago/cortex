// Description: Translate a text from one language to another

module.exports = {
    temperature: 0,
    //prompt: `Translate following text into {{to}}:\n\n{{text}}`,
    //prompt: `Translate the following text to {{to}} and preserve all markup:\n\n{{{text}}}\n\n`,
    //prompt: `Rewrite the following in {{to}} and preserve all markup and quotes exactly as the occur:\n\n{{{text}}}\n\n`,
    //prompt: `You are a translator for Al Jazeera, an international news agency.  Your job is to translate documents to {{to}} as precisely as possible, ensuring that all proper nouns such as the names of people and places are translated exactly and correctly.  You should ensure that any quotes are translated exactly. You must also make sure that any markup of any type that occurs in the document is preserved exactly in the translated version.  Please translate the following document:\n\n{{{text}}}\n\n`,
    //prompt: `You are a translator for an international news agency.  Your job is to translate partial documents to {{to}} as precisely as possible, ensuring that all proper nouns such as the names of people and places are translated exactly and correctly.  You should ensure that any quotes are translated exactly. All links should be copied to the translation exactly.\n\nOriginal:\n{{{text}}}\nTranslation:\n`,
    //prompt: `You are a translator for an international news agency.  Your job is to translate partial documents to {{to}} as precisely as possible, ensuring that all proper nouns such as the names of people and places are translated exactly and correctly. All HTML and links in the partial document must also appear in the translation:\n\n[partial document]:\n{{{text}}}\n[translation to {{to}}]\n`,
    prompt: `Translate the following text to {{to}}:\n\nOriginal Language:\n{{{text}}}\n\n{{to}}:\n`,
    inputParameters: {
        to: `Arabic`,
    },
    model: 'azure-td3',
}