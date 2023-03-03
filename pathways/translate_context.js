// Description: Translate a text from one language to another

module.exports = {
    temperature: 0,
    prompt:
        [
            // `{{{text}}}\n\nList all of the named entities in the above document in the original language:\n`,
            //`{{{previousResult}}}\n\nTranslate this list to {{to}}:\n`,
            //`{{{text}}}\nTranscribe the names of all people and places exactly from this document in the original language:\n`,
            `{{{text}}}\nCopy the names of all people and places exactly from this document in the language above:\n`,
            //`{{{previousResult}}}\n\nTranscribe exactly to {{to}}:\n`,
            `Original Language:\n{{{previousResult}}}\n\n{{to}}:\n`,
            //`Entities in the document:\n\n{{{previousResult}}}\n\nDocument:\n{{{text}}}\nTranslate the document to {{to}} and rewrite it to sound like a native {{to}} speaker:\n\n`
            `Entities in the document:\n\n{{{previousResult}}}\n\nDocument:\n{{{text}}}\nRewrite the document in {{to}}. If the document is already in {{to}}, copy it exactly below:\n`
        ],
    inputParameters: {
        to: `Arabic`,
        tokenRatio: 0.2,
    },
}