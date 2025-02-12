import { parse, build } from "@aj-archipelago/subvibe";
import logger from "../lib/logger.js";
import { callPathway } from "../lib/pathwayTools.js";

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

async function translateChunk(chunk, args, maxRetries = 3) {
  const chunkText = build(chunk.captions, { format: 'srt', preserveIndexes: true });
  
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

      const parsed = parse(content, { preserveIndexes: true });
      return parsed.cues;
      
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
      const parsed = parse(text);
      const captions = parsed.cues;
  
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

      return build(finalCaptions,format);
    } catch (e) {
      logger.error(`Subtitle translation failed: ${e}`);
      throw e;
    }
  },
};
