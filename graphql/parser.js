const nlp = require('compromise');
const plugin = require('compromise-paragraphs');
nlp.extend(plugin);

//simples form string single or list return
const getResponseResult = (data) => {
    const { choices } = data;
    if (!choices || !choices.length) {
        return; //TODO no choices case
    }
    const result = choices.map(({ text }) => text.trim());
    return result.length > 1 ? result : result[0];
}

//simply trim and parse with given regex
const regexParser = (text, regex) => {
    return text.trim().split(regex).map(s => s.trim()).filter(s => s.length);
}

// parse numbered list text format into list
// this supports most common numbered list returns like "1.", "1)", "1-"
const parseNumberedList = (str) => {
    return regexParser(str, /^\s*[\[\{\(]*\d+[\s.=:,;\]\)\}]/gm);
}

// parse a numbered object list text format into list of objects
const parseNumberedObjectList = (text, format) => {
    const fields = format.match(/\b(\w+)\b/g);
    const values = parseNumberedList(text);

    const result = [];
    for (const value of values) {
        try {
            const splitted = regexParser(value, /[:-](.*)/);
            const obj = {};
            for (let i = 0; i < fields.length; i++) {
                obj[fields[i]] = splitted[i];
            }
            result.push(obj);
        } catch (e) {
            console.warn(`Failed to parse value in parseNumberedObjectList, value: ${value}, fields: ${fields}`);
        }
    }

    return result;
}

const getSemanticChunks = (text, maxChunkLength) => {
    // Chunk input into paragraphs if needed
    let paragraphChunks = nlp(text).paragraphs().views.map(v => v.text());

    // Chunk paragraphs into sentences if needed
    const sentenceChunks = [];
    for (let i = 0; i < paragraphChunks.length; i++) {
        if (paragraphChunks[i].length > maxChunkLength) { // too long paragraph, chunk into sentences
            sentenceChunks.push(...nlp(paragraphChunks[i]).sentences().json().map(v => v.text));
        } else {
            sentenceChunks.push(paragraphChunks[i]);
        }
    }

    // Chunk sentences with newlines if needed
    const newlineChunks = [];
    for (let i = 0; i < sentenceChunks.length; i++) {
        if (sentenceChunks[i].length > maxChunkLength) { // too long, split into lines
            newlineChunks.push(...sentenceChunks[i].split('\n'));
        } else {
            newlineChunks.push(sentenceChunks[i]);
        }
    }

    // Chunk sentences into word chunks if needed
    let chunks = [];
    for (let j = 0; j < newlineChunks.length; j++) {
        if (newlineChunks[j].length > maxChunkLength) {
            // too long sentence, chunk into words
            const words = newlineChunks[j].split(/\s+/);
            // merge words into chunks up to maxChunkLength
            let chunk = '';
            for (let k = 0; k < words.length; k++) {
                if (chunk.length + words[k].length > maxChunkLength) {
                    chunks.push(chunk.trim());
                    chunk = '';
                }
                chunk += words[k] + ' ';
            }
            if (chunk.length > 0) {
                chunks.push(chunk.trim());
            }
        } else {
            chunks.push(newlineChunks[j]);
        }
    }
    // Filter empty chunks
    chunks = chunks.filter(Boolean);

    // Merge chunks into maxChunkLength chunks
    let mergedChunks = [];
    let chunk = '';
    for (let i = 0; i < chunks.length; i++) {
        if (chunk.length + chunks[i].length > maxChunkLength) {
            mergedChunks.push(chunk);
            chunk = '';
        }
        chunk += chunks[i];
    }
    if (chunk.length > 0) {
        mergedChunks.push(chunk);
    }
    return mergedChunks;
}

const semanticTruncate = (text, maxLength) => {
    if (text.length > maxLength) {
        text = getSemanticChunks(text, maxLength)[0].slice(0, maxLength - 3).trim() + "...";
    }
    return text;
}

module.exports = {
    getResponseResult,
    regexParser,
    parseNumberedList,
    parseNumberedObjectList,
    getSemanticChunks,
    semanticTruncate
};
