module.exports = {
    temperature: 0,
    prompt: [`Correct spelling and grammar in the input text below.\n\nInput:\n{{{text}}}\n\nCorrected:\n`,
        `Use British English word spellings in the input text below.\n\nInput:\n{{{previousResult}}}\n\nCorrected:\n`,
        `Unless using a full official title, use lower case. Jobs are lower case, eg the UK prime minister, the US secretary of state. If the individuals name follows, you capitalise (Prime Minister Theresa May) We only capitalise the name of ministries if it is their proper name, so US Department of State but US state department… diaspora ministry and Ministry of Diaspora Affairs. Place names and organisations are capitalised, eg the World Trade Center. Police, armies, navies, air forces, coastguards etc do not require capitals. So the Russian army, the US air force, the Chinese coastguard. The West and Western nations when referring to political designations. Geographic designations are lower case. Apply all of these rules to the input text below.\n\nInput:\n{{{previousResult}}}\n\nCorrected:\n`,
        `Don't use the % sign - spell out percent instead. Expand all abbreviated month names. Expand monetary abbreviations. Apply all of these rules to the input text below.\n\nInput:\n{{{previousResult}}}\n\nCorrected:\n`,
        `Do not use nouns or adjectives as verbs. Examples: do not progress reports, do not action an order. Events do not take place Monday, they take place on Monday. You do not write a person, you write to a person. You do not protest a law, you protest against it. You do not appeal a decision, you appeal against it. Apply all of these rules to the input text below.\n\nInput:\n{{{previousResult}}}\n\nCorrected:\n`,
        `Do not mix tenses.  Apply this rule to the input text below.\n\nInput:\n{{{previousResult}}}\n\nCorrected:\n`,
        `Mask any profanity with the first letter of the word followed by asterisks in the input text below.\n\nInput:\n{{{previousResult}}}\n\nCorrected:\n`
    ],
    useInputChunking: true,
    useParallelChunkProcessing: true,
    model: 'azure-td2',
    timeout: 300, // in seconds
}