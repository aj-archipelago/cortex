import { encode, decode } from '../lib/encodeCache.js';
import * as cheerio from 'cheerio';

const getLastNToken = (text, maxTokenLen) => { 
    const encoded = encode(text);
    if (encoded.length > maxTokenLen) {
        text = decode(encoded.slice(-maxTokenLen));
        text = text.slice(text.search(/\s/) + 1); // skip potential partial word
    }
    return text;
}

const getFirstNToken = (text, maxTokenLen) => {
  if (Array.isArray(text)) {
    return getFirstNTokenArray(text, maxTokenLen);
  } else {
    return getFirstNTokenSingle(text, maxTokenLen);
  }
}

const getFirstNTokenSingle = (text, maxTokenLen) => {
  if (maxTokenLen <= 0 || !text) {
    return '';
  }

  const encoded = encode(text);
  if (encoded.length > maxTokenLen) {
      text = decode(encoded.slice(0, maxTokenLen));
  }
  return text;
}

function getFirstNTokenArray(content, tokensToKeep) {
  let totalTokens = 0;
  let result = [];

  if (tokensToKeep <= 0 || !content || content.length === 0) {
    return result;
  }

  for (let i = content.length - 1; i >= 0; i--) {
      const message = content[i];
      const messageTokens = encode(message).length;

      if (totalTokens + messageTokens <= tokensToKeep) {
          totalTokens += messageTokens;
          result.unshift(message); // Add message to the start
      } else {
          try{
            const messageObj = JSON.parse(message);
            if(messageObj.type === "image_url"){
              break;
            }
          }catch(e){
            // ignore
          }

          const remainingTokens = tokensToKeep - totalTokens;
          const truncatedMessage = getFirstNToken(message, remainingTokens);
          result.unshift(truncatedMessage); // Add truncated message to the start
          break;
      }
  }

  return result;
}

const determineTextFormat = (text) => {
  const htmlTagPattern = /<[^>]*>/g;
  
  if (htmlTagPattern.test(text)) {
    return 'html';
  }
  else {
    return 'text';
  }
}

const getSemanticChunks = (text, chunkSize, inputFormat = 'text') => {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error('Invalid chunkSize: must be a positive integer');
  }

  if (inputFormat === 'html') {
    return getHtmlChunks(text, chunkSize);
  } else {
    // Pre-calculate encoding ratio with a sample to avoid encoding entire text
    const sampleSize = Math.min(500, text.length);
    const sample = text.slice(0, sampleSize);
    const sampleEncoded = encode(sample);
    const avgCharsPerToken = sample.length / sampleEncoded.length;
    const charChunkSize = Math.round(chunkSize * avgCharsPerToken);
    return findChunks(text, charChunkSize, chunkSize);
  }
}

const getHtmlChunks = (html, chunkSize) => {
  const $ = cheerio.load(html, null, true);
  const nodes = $('body').contents().map((_, el) => $.html(el)).get();
  
  let chunks = [];
  let currentChunk = '';
  
  for (const node of nodes) {
    if (encode(node).length > chunkSize && node.startsWith('<') && node.endsWith('>')) {
      throw new Error('The HTML contains elements that are larger than the chunk size. Please try again with HTML that has smaller elements.');
    }
    
    if (encode(currentChunk + node).length <= chunkSize) {
      currentChunk += node;
    } else {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = '';
      }
      if (encode(node).length > chunkSize) {
        // If the node is larger than chunkSize, split it
        const textChunks = getSemanticChunks(node, chunkSize, 'text');
        chunks.push(...textChunks);
      } else {
        currentChunk = node;
      }
    }
  }
  
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  
  return chunks;
};

const findChunks = (text, chunkSize, maxTokenLen) => {
  const chunks = [];
  let startIndex = 0;

  while (startIndex < text.length) {
    let endIndex = Math.min(startIndex + chunkSize, text.length);

    if (endIndex == text.length) {
      chunks.push(text.slice(startIndex));
      break;
    }

    const searchWindow = text.slice(startIndex, endIndex);
    
    // Find semantic break point, minimum 1 character
    let breakPoint = Math.max(findSemanticBreak(searchWindow), 1);
    let chunk = searchWindow.slice(0, breakPoint);

    // If chunk is too large, reduce size until it fits
    while (encode(chunk).length > maxTokenLen && chunkSize > 1) {
      // reduce chunk size by a proportional amount
      const reductionFactor = maxTokenLen / encode(chunk).length;
      chunkSize = Math.floor(chunkSize * reductionFactor);
      endIndex = Math.min(chunkSize, searchWindow.length);
      breakPoint = Math.max(findSemanticBreak(searchWindow.slice(0, endIndex)), 1);
      chunk = searchWindow.slice(0, breakPoint);
    }

    // Force single character if still too large
    if (encode(chunk).length > maxTokenLen) {
      breakPoint = 1;
      chunk = searchWindow.slice(0, 1);
    }

    chunks.push(chunk);
    startIndex += breakPoint;
  }

  return chunks;
}

const findSemanticBreak = (text) => {
  const findLastDelimiter = (text, delimiters) => {
    let lastIndex = -1;
    for (const delimiter of delimiters) {
      const index = text.lastIndexOf(delimiter);
      if (index > -1) {
        const delimitedIndex = index + delimiter.length;
        if (delimitedIndex > lastIndex) lastIndex = delimitedIndex;
      }
    }
    return lastIndex;
  }

  let breakIndex;

  // Look for paragraph break (including different newline styles)
  const paragraphDelimiters = ['\n\n', '\r\n\r\n', '\r\r', '\n'];
  breakIndex = findLastDelimiter(text, paragraphDelimiters);
  if (breakIndex !== -1) return breakIndex;

  // Look for sentence break
  const sentenceDelimiters = [
    // Latin/European
    '.', '!', '?', 
    // CJK
    '。', '！', '？', '．', '…', 
    // Arabic/Persian/Urdu
    '؟', '۔', '.',
    // Devanagari/Hindi
    '।',
    // Thai
    '๏', 'ฯ',
    // Armenian
    '։',
    // Ethiopian
    '።'
  ];
  breakIndex = findLastDelimiter(text, sentenceDelimiters);
  if (breakIndex !== -1) return breakIndex;

  // Look for phrase break
  const phraseDelimiters = [
    // Latin/European
    '-', ';', ':', ',',
    // CJK
    '、', '，', '；', '：', '─',
    // Arabic/Persian/Urdu
    '،', '؛', '٬',
    // Devanagari/Hindi
    '॥', ',',
    // Thai
    '๚', '、'
  ];
  breakIndex = findLastDelimiter(text, phraseDelimiters);
  if (breakIndex !== -1) return breakIndex;

  // Look for word break (Unicode whitespace)
  const whitespaceDelimiters = [
    ' ',    // Space
    '\t',   // Tab
    '\u00A0', // No-Break Space
    '\u1680', // Ogham Space Mark
    '\u2000', // En Quad
    '\u2001', // Em Quad
    '\u2002', // En Space
    '\u2003', // Em Space
    '\u2004', // Three-Per-Em Space
    '\u2005', // Four-Per-Em Space
    '\u2006', // Six-Per-Em Space
    '\u2007', // Figure Space
    '\u2008', // Punctuation Space
    '\u2009', // Thin Space
    '\u200A', // Hair Space
    '\u202F', // Narrow No-Break Space
    '\u205F', // Medium Mathematical Space
    '\u3000'  // Ideographic Space
  ];
  breakIndex = findLastDelimiter(text, whitespaceDelimiters);
  if (breakIndex !== -1) return breakIndex;
  
  return text.length - 1;
};

const semanticTruncate = (text, maxLength) => {
  if (text.length <= maxLength) {
    return text;
  }

  const truncatedText = text.slice(0, maxLength - 3).trim();
  const lastSpaceIndex = truncatedText.lastIndexOf(" ");

  return (lastSpaceIndex !== -1)
    ? truncatedText.slice(0, lastSpaceIndex) + "..."
    : truncatedText + "...";
};

const getSingleTokenChunks = (text) => {
  if (text === '') return [''];
  
  const tokens = encode(text);
  
  // To maintain reversibility, we need to decode tokens in sequence
  // Create an array of chunks where each position represents the text up to that token
  const chunks = [];
  for (let i = 0; i < tokens.length; i++) {
    // Decode current token
    const currentChunk = decode(tokens.slice(i, i+1));
    // Add to result
    chunks.push(currentChunk);
  }
  
  return chunks;
}

export {
    getSemanticChunks, semanticTruncate, getLastNToken, getFirstNToken, determineTextFormat, getSingleTokenChunks
};
