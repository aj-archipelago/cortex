

const shortenText = async (text) => {
    // return pass({ prompt: `${text}\n\n tl;dr:` });
    return pass({ prompt: prompten(text, 'Write a short summary of the following:') });
}

// TODO 4 char a token
const MAX_SHORTENING_RECURSION = 10;
const shortlenLongText = async (text, promptLength = 24, curRecurse = 0) => {
    if (curRecurse >= MAX_SHORTENING_RECURSION) return text;
    const chunkSize = 1024 - promptLength;
    const encoded = encode(text);
    if (!encoded || encoded.length < chunkSize) return text;

    const result = []
    for (let i = 0; i < encoded.length; i += chunkSize) {
        const chunk = encoded.slice(i, i + chunkSize);
        const curText = decode(chunk)
        const shortText = await shortenText(curText)
        result.push(shortText);
    }
    return await shortlenLongText(result.join(), promptLength, curRecurse + 1);
}

const PROMPT = `Write a short summary of the following: \n\n{{text}}`;

module.exports = {
    prompt: PROMPT,
    // parser: async (summary, reprompt) => {
    //     let i = 0
    //     while (summary.length > 200 && i < 3) {
    //         console.log('reprompting', summary.length)
    //         summary = await reprompt(PROMPT, summary)
    //         i++
    //     }

    //     if (summary.length > 200) {
    //         const chunks = summary.split('.').map(s => s.trim())

    //         const included = []
    //         let totalLength = 0
    //         for (let i = 0; i < chunks.length; i++) {
    //             const chunk = chunks[i]
    //             included.push(chunk)
    //             totalLength += chunk.length

    //             if (totalLength.length >= 200) {
    //                 break;
    //             }
    //         }

    //         summary = included.join('. ')
    //     }
    //     return summary;
    // }
}
