import { parse, build } from "@aj-archipelago/subvibe";
import logger from "../lib/logger.js";
import { callPathway } from "../lib/pathwayTools.js";

export function splitIntoOverlappingChunks(captions, chunkSize = 20, overlap = 3) {
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

export function selectBestTranslation(translations, startIndex, endIndex) {
  try {
    if (!translations || !Array.isArray(translations)) {
      logger.warn(`Invalid translations input: ${JSON.stringify(translations)}`);
      return null;
    }
    
    if (translations.length === 0) {
      logger.warn(`No translations available for selection`);
      return null;
    }
    
    // If we only have one translation for this caption, use it
    if (translations.length === 1) return translations[0];

    // Use the first translation as a starting point
    const first = translations[0];
    
    // For multiple translations, prefer the one whose identifier is closest to the middle
    // of the requested range
    const startNum = Number(startIndex);
    const endNum = Number(endIndex);
    const targetValue = (isNaN(startNum) || isNaN(endNum)) ? 0 : (startNum + endNum) / 2;
    
    return translations.reduce((best, current) => {
      try {
        // Use identifier for comparison if available, otherwise use index
        const currentValue = Number(current.identifier !== undefined ? current.identifier : current.index || 0);
        const bestValue = Number(best.identifier !== undefined ? best.identifier : best.index || 0);
        
        const currentDistance = Math.abs(currentValue - targetValue);
        const bestDistance = Math.abs(bestValue - targetValue);
        
        return currentDistance < bestDistance ? current : best;
      } catch (err) {
        logger.warn(`Error comparing translations: ${err.message}`);
        return best; // Fallback to existing best on error
      }
    }, first);
  } catch (err) {
    logger.error(`Error in selectBestTranslation: ${err.message}`);
    // Return the first translation if available, otherwise null
    return translations && translations.length ? translations[0] : null;
  }
}

export async function translateChunk(chunk, args, maxRetries = 3) {
  const chunkText = build(chunk.captions, { format: args.format, preserveIndexes: true });
  
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
      return parsed.cues || [];
      
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
  executePathway: async ({args, resolver}) => {
    try {
      const combinedArgs = { ...resolver?.pathway?.inputParameters, ...args };
      const { text, format = 'vtt' } = combinedArgs;

      const parsed = parse(text, { format, preserveIndexes: true });
      const captions = parsed.cues;
  
      if (!captions || captions.length === 0) {
        throw new Error("No captions found in input");
      }
  
      // Split into overlapping chunks
      const chunks = splitIntoOverlappingChunks(captions);
      logger.info(`Split subtitles into ${chunks.length} overlapping chunks`);
      
      // Translate all chunks in parallel
      const chunkPromises = chunks.map(chunk => translateChunk(chunk, combinedArgs));
      const translatedChunks = await Promise.all(chunkPromises);
      
      // Create a map of caption index to all its translations
      const translationMap = new Map();
      translatedChunks.flat().forEach(caption => {
        // Skip null/undefined captions
        if (!caption) return;
        
        const identifier = String(caption.identifier || caption.index || 'unknown');
        if (!translationMap.has(identifier)) {
          translationMap.set(identifier, []);
        }
        translationMap.get(identifier).push(caption);
      });
      
      // Select best translation for each caption
      const finalCaptions = captions.map(caption => {
        const identifier = String(caption.identifier || caption.index || 'unknown');
        const translations = translationMap.get(identifier) || [caption];
        const bestTranslation = selectBestTranslation(translations, identifier, identifier);
        const text = bestTranslation?.text || caption?.text || '';
        return { ...caption, text };
      });

      return build(finalCaptions, { format, preserveIndexes: true });
    } catch (e) {
      logger.error(`Subtitle translation failed: ${e}`);
      throw e;
    }
  },
};
