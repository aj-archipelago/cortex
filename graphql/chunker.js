const { encode, decode } = require('gpt-3-encoder')

const estimateCharPerToken = (text) => {
    // check text only contains asciish characters
    if (/^[ -~\t\n\r]+$/.test(text)) {
        return 4;
    }
    return 1;
}

const getLastNChar = (text, maxLen) => {
    if (text.length > maxLen) {
        //slice text to avoid maxLen limit but keep the last n characters up to a \n or space to avoid cutting words
        text = text.slice(-maxLen);
        text = text.slice(text.search(/\s/) + 1);
    }
    return text;
}

const getLastNToken = (text, maxTokenLen) => { 
    const encoded = encode(text);
    if (encoded.length > maxTokenLen) {
        text = decode(encoded.slice(-maxTokenLen));
        text = text.slice(text.search(/\s/) + 1); // skip potential partial word
    }
    return text;
}

const getFirstNToken = (text, maxTokenLen) => {
    const encoded = encode(text);
    if (encoded.length > maxTokenLen) {
        text = decode(encoded.slice(0, maxTokenLen + 1));
        text = text.slice(0,text.search(/\s[^\s]*$/)); // skip potential partial word
    }
    return text;
}

const isBigChunk = ({ text, maxChunkLength, maxChunkToken }) => {
    if (maxChunkLength && text.length > maxChunkLength) {
        return true;
    }
    if (maxChunkToken && encode(text).length > maxChunkToken) {
        return true;
    }
    return false;
}

const getSemanticChunks = ({ text, maxChunkLength, maxChunkToken,
    enableParagraphChunks = true, enableSentenceChunks = true, enableLineChunks = true,
    enableWordChunks = true, finallyMergeChunks = true }) => {

    if (maxChunkLength && maxChunkLength <= 0) {
        throw new Error(`Invalid maxChunkLength: ${maxChunkLength}`);
    }
    if (maxChunkToken && maxChunkToken <= 0) {
        throw new Error(`Invalid maxChunkToken: ${maxChunkToken}`);
    }

    const isBig = (text) => {
        return isBigChunk({ text, maxChunkLength, maxChunkToken });
    }

    // split into paragraphs
    let paragraphChunks = enableParagraphChunks ? text.split('\n\n') : [text];

    // Chunk paragraphs into sentences if needed
    const sentenceChunks = enableSentenceChunks ? [] : paragraphChunks;
    for (let i = 0; enableSentenceChunks && i < paragraphChunks.length; i++) {
        if (isBig(paragraphChunks[i])) { // too long paragraph, chunk into sentences
            sentenceChunks.push(...paragraphChunks[i].split('.\n')); // split into sentences
        } else {
            sentenceChunks.push(paragraphChunks[i]);
        }
    }

    // Chunk sentences with newlines if needed
    const newlineChunks = enableLineChunks ? [] : sentenceChunks;
    for (let i = 0; enableLineChunks && i < sentenceChunks.length; i++) {
        if (isBig(sentenceChunks[i])) { // too long, split into lines
            newlineChunks.push(...sentenceChunks[i].split('\n'));
        } else {
            newlineChunks.push(sentenceChunks[i]);
        }
    }

    // Chunk sentences into word chunks if needed
    let chunks = enableWordChunks ? [] : newlineChunks;
    for (let j = 0; enableWordChunks && j < newlineChunks.length; j++) {
        if (isBig(newlineChunks[j])) { // too long sentence, chunk into words
            const words = newlineChunks[j].split(' ');
            // merge words into chunks up to max
            let chunk = '';
            for (let k = 0; k < words.length; k++) {
                if (isBig( chunk + ' ' + words[k]) ) {
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

    chunks = chunks.filter(Boolean).map(chunk => '\n' + chunk + '\n'); //filter empty chunks and add newlines

    return finallyMergeChunks ? mergeChunks({ chunks, maxChunkLength, maxChunkToken }) : chunks;
}

const mergeChunks = ({ chunks, maxChunkLength, maxChunkToken }) => {
    const isBig = (text) => {
        return isBigChunk({ text, maxChunkLength, maxChunkToken });
    }

    // Merge chunks into maxChunkLength chunks
    let mergedChunks = [];
    let chunk = '';
    for (let i = 0; i < chunks.length; i++) {
        if (isBig(chunk + ' ' + chunks[i])) {
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
        text = getSemanticChunks({ text, maxChunkLength: maxLength })[0].slice(0, maxLength - 3).trim() + "...";
    }
    return text;
}



module.exports = {
    getSemanticChunks, semanticTruncate, mergeChunks,
    getLastNChar, getLastNToken, getFirstNToken, estimateCharPerToken
}