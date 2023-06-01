import { encode, decode } from 'gpt-3-encoder';
import cheerio from 'cheerio';

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
  const breakByRegex = (str, regex, preserveWhitespace = false) => {
    const result = [];
    let match;
  
    while ((match = regex.exec(str)) !== null) {
      const value = str.slice(0, match.index);
      result.push(value);
  
      if (preserveWhitespace || /\S/.test(match[0])) {
        result.push(match[0]);
      }
  
      str = str.slice(match.index + match[0].length);
    }
  
    if (str) {
      result.push(str);
    }
  
    return result.filter(Boolean);
  };

  const breakByParagraphs = (str) => breakByRegex(str, /[\r\n]+/, true);
  const breakBySentences = (str) => breakByRegex(str, /(?<=[.。؟！?!\n])\s+/, true);
  const breakByWords = (str) => breakByRegex(str, /(\s,;:.+)/);

  const breakByHtmlElements = (str) => {
    const $ = cheerio.load(str, null, true);

    // the .filter() call is important to get the text nodes
    // https://stackoverflow.com/questions/54878673/cheerio-get-normal-text-nodes
    let rootNodes = $('body').contents();

    // create an array with the outerHTML of each node
    const nodes = rootNodes.map((i, el) => $(el).prop('outerHTML') || $(el).text()).get();

    // remove newlines from each node
    nodes.forEach((node, i) => {
        nodes[i] = node.replace(/\r?\n|\r/g, " ").trim();
    });

    return nodes.map(n => n + '\n\n').filter(n => n);
};

  const createChunks = (tokens) => {
    let chunks = [];
    let currentChunk = '';
  
    for (const token of tokens) {
      const currentTokenLength = encode(currentChunk + token).length;
      if (currentTokenLength <= chunkSize) {
        currentChunk += token;
      } else {
        if (currentChunk) {
          chunks.push(currentChunk);
        }
        currentChunk = token;
      }
    }
  
    if (currentChunk) {
      chunks.push(currentChunk);
    }
  
    return chunks;
  };

  const combineChunks = (chunks) => {
    let optimizedChunks = [];
  
    for (let i = 0; i < chunks.length; i++) {
      if (i < chunks.length - 1) {
        const combinedChunk = chunks[i] + chunks[i + 1];
        const combinedLen = encode(combinedChunk).length;
  
        if (combinedLen <= chunkSize) {
          optimizedChunks.push(combinedChunk);
          i += 1;
        } else {
          optimizedChunks.push(chunks[i]);
        }
      } else {
        optimizedChunks.push(chunks[i]);
      }
    }
  
    return optimizedChunks;
  };

  const breakText = (str) => {
    const tokenLength = encode(str).length;

    if (tokenLength <= chunkSize) {
      return [str];
    }

    const breakers = [breakByParagraphs, breakBySentences, breakByWords];

    for (let i = 0; i < breakers.length; i++) {
      const tokens = breakers[i](str);
      if (tokens.length > 1) {
        let chunks = createChunks(tokens);
        chunks = combineChunks(chunks);
        const brokenChunks = chunks.flatMap(breakText);
        if (brokenChunks.every(chunk => encode(chunk).length <= chunkSize)) {
          return brokenChunks;
        }
      }
    }

    return createChunks([...str]); // Split by characters
  };

  if (inputFormat === 'html') {
    const tokens = breakByHtmlElements(text);
    let chunks = createChunks(tokens);
    chunks = combineChunks(chunks);

    chunks = chunks.flatMap(chunk => {
      if (determineTextFormat(chunk) === 'text') {
        return getSemanticChunks(chunk, chunkSize);
      } else {
        return chunk;
      }
    });

    if (chunks.some(chunk => encode(chunk).length > chunkSize)) {
      throw new Error('The HTML contains elements that are larger than the chunk size. Please try again with HTML that has smaller elements.');
    }

    return chunks;
  }
  else {
      return breakText(text);
  }
}


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

export {
    getSemanticChunks, semanticTruncate, getLastNToken, getFirstNToken, determineTextFormat
};