import logger from "../lib/logger.js";
import { callPathway } from "../lib/pathwayTools.js";

function preprocessStr(str, format) {
  try {
    if (!str) return "";
    let content = str
      // Normalize line endings
      .replace(/\r\n?/g, "\n")
      // Remove WEBVTT header for processing
      .replace(/^WEBVTT\n\n/, '');

    // For SRT, convert commas to dots in timestamps
    if (format === 'srt') {
      content = content.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
    }

    return content
      // Ensure each subtitle block is properly separated
      .split(/\n\s*\n/)
      .map(block => block.trim())
      .filter(block => {
        // Match both numeric indices (SRT) and optional caption identifiers (VTT)
        const firstLine = block.split('\n')[0];
        return block && (
          /^\d+$/.test(firstLine) || // SRT style
          /^\d{2}:\d{2}/.test(firstLine) || // VTT style without identifier
          /^[^\n]+\n\d{2}:\d{2}/.test(block) // VTT style with identifier
        );
      })
      .join("\n\n")
      + "\n\n";
  } catch (e) {
    logger.error(`An error occurred in content text preprocessing: ${e}`);
    return "";
  }
}

function timeToMs(timeStr) {
  const [time, ms] = timeStr.split(/[.,]/);
  const [hours, minutes, seconds] = time.split(':').map(Number);
  return (hours * 3600 + minutes * 60 + seconds) * 1000 + parseInt(ms);
}

function msToTimestamp(ms, format) {
  const date = new Date(ms);
  const timestamp = date.toISOString().slice(11, 23);
  return format === 'srt' ? timestamp.replace('.', ',') : timestamp;
}

function parseSubtitles(content, format) {
  const blocks = content.split(/\n\s*\n/).filter(block => block.trim());
  const captions = [];
  
  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length < 2) continue;
    
    let index, timelineIndex;
    if (format === 'srt') {
      // SRT format: numeric index required
      if (!/^\d+$/.test(lines[0])) continue;
      index = parseInt(lines[0]);
      timelineIndex = 1;
    } else {
      // VTT format: optional identifier
      timelineIndex = /^\d{2}:\d{2}/.test(lines[0]) ? 0 : 1;
      index = timelineIndex === 0 ? captions.length + 1 : lines[0];
    }
    
    const timeMatch = lines[timelineIndex].match(/^(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/);
    if (!timeMatch) continue;
    
    const startTime = timeMatch[1].replace(',', '.');
    const endTime = timeMatch[2].replace(',', '.');
    const content = lines.slice(timelineIndex + 1).join('\n');
    
    captions.push({
      type: "caption",
      index: typeof index === 'number' ? index : captions.length + 1,
      identifier: typeof index === 'string' ? index : null,
      start: timeToMs(startTime),
      end: timeToMs(endTime),
      duration: timeToMs(endTime) - timeToMs(startTime),
      content: content,
      text: content
    });
  }
  
  return captions;
}

function splitIntoOverlappingChunks(captions, chunkSize = 20, overlap = 3) {
  const chunks = [];
  for (let i = 0; i < captions.length; i += (chunkSize - overlap)) {
    const end = Math.min(i + chunkSize, captions.length);
    const chunk = captions.slice(i, end);
    chunks.push({
      captions: chunk,
      startIndex: i,
      endIndex: end - 1,
      isOverlap: i > 0 || end < captions.length
    });
  }
  return chunks;
}

function selectBestTranslation(translations, startIndex, endIndex) {
  // If we only have one translation for this caption, use it
  if (translations.length === 1) return translations[0];

  // For multiple translations, prefer the one from the middle of its chunk
  // This helps avoid edge effects in translation
  return translations.reduce((best, current) => {
    const currentDistance = Math.min(
      Math.abs(current.chunkStart - startIndex),
      Math.abs(current.chunkEnd - endIndex)
    );
    const bestDistance = Math.min(
      Math.abs(best.chunkStart - startIndex),
      Math.abs(best.chunkEnd - endIndex)
    );
    return currentDistance < bestDistance ? current : best;
  });
}

function validateFinalOutput(result, originalText, format) {
  // Basic structure validation
  if (!result || !result.trim()) {
    logger.error("Empty or whitespace-only result");
    return false;
  }
  
  // Check for VTT header if needed
  if (format === 'vtt' && !result.startsWith('WEBVTT\n\n')) {
    logger.error("Missing WEBVTT header");
    return false;
  }
  
  // Check for timestamp format
  const timestampPattern = format === 'srt' 
    ? /\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/
    : /\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}/;
  
  const hasTimestamps = timestampPattern.test(result);
  if (!hasTimestamps) {
    logger.error(`No valid ${format.toUpperCase()} timestamps found in result`);
    return false;
  }

  // Check overall length ratio
  if (result.length < originalText.length * 0.5) {
    logger.error(`Result length (${result.length}) is less than 50% of original length (${originalText.length})`);
    return false;
  }

  // Validate subtitle block structure
  const blocks = result.split(/\n\s*\n/).filter(block => block.trim());
  
  // Skip WEBVTT header for VTT format
  const startIndex = format === 'vtt' && blocks[0].trim() === 'WEBVTT' ? 1 : 0;
  
  for (let i = startIndex; i < blocks.length; i++) {
    const block = blocks[i];
    const lines = block.trim().split('\n');
    
    if (lines.length < 2) {
      logger.error(`Block ${i + 1} has insufficient lines (${lines.length}):\n${block}`);
      return false;
    }
    
    // Find the timestamp line
    let timestampLineIndex = -1;
    for (let j = 0; j < lines.length; j++) {
      if (timestampPattern.test(lines[j])) {
        timestampLineIndex = j;
        break;
      }
    }
    
    if (timestampLineIndex === -1) {
      logger.error(`Block ${i + 1} has no valid timestamp line:\n${block}`);
      return false;
    }
    
    // Check that we have content after the timestamp
    if (timestampLineIndex === lines.length - 1) {
      logger.error(`Block ${i + 1} has no content after timestamp:\n${block}`);
      return false;
    }
    
    // Log the content for inspection
    logger.debug(`Block ${i + 1} content:\n${lines.slice(timestampLineIndex + 1).join('\n')}`);
  }

  return true;
}

async function translateChunk(chunk, args, maxRetries = 3) {
  const format = args.format || 'srt';
  const chunkText = chunk.captions
    .map(c => {
      const startTime = msToTimestamp(c.start, format);
      const endTime = msToTimestamp(c.end, format);
      const index = format === 'srt' || !c.identifier ? c.index : c.identifier;
      return `${index}\n${startTime} --> ${endTime}\n${c.content}`;
    })
    .join('\n\n');
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const translated = await callPathway("translate_subtitle_helper", {
        ...args,
        text: chunkText,
        async: false,
      });

      // Basic validation - just check for SUBTITLES tags and some content
      const match = translated.match(/<SUBTITLES>([\s\S]*)<\/SUBTITLES>/);
      if (!match || !match[1].trim()) {
        logger.warn(`Attempt ${attempt + 1}: Invalid translation format`);
        continue;
      }
      
      const content = match[1].trim();
      const blocks = content.split(/\n\s*\n/);
      
      // Check if any blocks are empty or invalid
      let hasEmptyBlocks = false;
      const processedBlocks = chunk.captions.map((caption, index) => {
        const block = blocks[index];
        if (!block) {
          logger.warn(`Attempt ${attempt + 1}: Empty block for caption ${caption.index}`);
          hasEmptyBlocks = true;
          return null;
        }
        
        const lines = block.split('\n');
        if (lines.length < 3) {
          logger.warn(`Attempt ${attempt + 1}: Invalid block structure for caption ${caption.index}`);
          hasEmptyBlocks = true;
          return null;
        }
        
        const content = lines.slice(2).join('\n').trim();
        if (!content) {
          logger.warn(`Attempt ${attempt + 1}: Empty content for caption ${caption.index}`);
          hasEmptyBlocks = true;
          return null;
        }
        
        return {
          ...caption,
          content: content,
          text: content,
          chunkStart: chunk.startIndex,
          chunkEnd: chunk.endIndex
        };
      });
      
      // If no empty blocks, return the processed blocks
      if (!hasEmptyBlocks) {
        return processedBlocks;
      }
      
      // If this was the last attempt and we still have empty blocks,
      // return what we have but keep original content for empty blocks
      if (attempt === maxRetries - 1) {
        logger.warn(`Failed to get valid translations for all blocks after ${maxRetries} attempts`);
        return chunk.captions.map((caption, index) => {
          return processedBlocks[index] || {
            ...caption,
            chunkStart: chunk.startIndex,
            chunkEnd: chunk.endIndex
          };
        });
      }
      
      // Otherwise, try again
      logger.info(`Retrying chunk due to empty blocks (attempt ${attempt + 1}/${maxRetries})`);
      
    } catch (e) {
      logger.error(`Error translating chunk ${chunk.startIndex}-${chunk.endIndex} (attempt ${attempt + 1}): ${e}`);
      if (attempt === maxRetries - 1) throw e;
    }
  }
  
  throw new Error(`Failed to translate chunk ${chunk.startIndex}-${chunk.endIndex} after ${maxRetries} attempts`);
}

export default {
  inputParameters: {
    to: `Arabic`,
    tokenRatio: 0.2,
    format: `srt`,
    prevLines: ``,
    nextLines: ``,
  },
  useInputChunking: false,
  model: "oai-gpt4o",
  enableDuplicateRequests: false,
  timeout: 3600,
  executePathway: async ({args}) => {
    try {
      const { text, format = 'srt' } = args;
      const preprocessedText = preprocessStr(text, format);
      const captions = parseSubtitles(preprocessedText, format);
  
      if (!captions || captions.length === 0) {
        throw new Error("No captions found in input");
      }
  
      // Split into overlapping chunks
      const chunks = splitIntoOverlappingChunks(captions);
      logger.info(`Split subtitles into ${chunks.length} overlapping chunks`);
      
      // Translate all chunks in parallel
      const chunkPromises = chunks.map(chunk => translateChunk(chunk, args));
      const translatedChunks = await Promise.all(chunkPromises);
      
      // Create a map of caption index to all its translations
      const translationMap = new Map();
      translatedChunks.flat().forEach(caption => {
        if (!translationMap.has(caption.index)) {
          translationMap.set(caption.index, []);
        }
        translationMap.get(caption.index).push(caption);
      });
      
      // Select best translation for each caption
      const finalCaptions = captions.map(caption => {
        const translations = translationMap.get(caption.index) || [caption];
        return selectBestTranslation(translations, caption.index, caption.index);
      });
      
      // Format the output
      let result = finalCaptions
        .map(caption => {
          const startTime = msToTimestamp(caption.start, format);
          const endTime = msToTimestamp(caption.end, format);
          // Only include index/identifier if it was in the original
          const hasIdentifier = caption.identifier !== null || format === 'srt';
          const index = format === 'srt' || !caption.identifier ? caption.index : caption.identifier;
          return hasIdentifier ? 
            `${index}\n${startTime} --> ${endTime}\n${caption.content}` :
            `${startTime} --> ${endTime}\n${caption.content}`;
        })
        .join('\n\n')
        .trim();

      // Add final newline only if input had one
      if (text.endsWith('\n')) {
        result += '\n';
      }

      // Add WEBVTT header for VTT format
      if (format === 'vtt') {
        result = 'WEBVTT\n\n' + result;
      }

      // Validate final output
      if (!validateFinalOutput(result, text, format)) {
        throw new Error("Final subtitle reconstruction failed validation");
      }

      return result;
    } catch (e) {
      logger.error(`Subtitle translation failed: ${e}`);
      throw e;
    }
  },
};
