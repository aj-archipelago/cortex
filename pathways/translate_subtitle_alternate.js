import subsrt from "subsrt";
import logger from "../lib/logger.js";
import { callPathway } from "../lib/pathwayTools.js";

function preprocessStr(str) {
    try {
      if (!str) return "";
      return (
        str
          .replace(/\r\n?/g, "\n")
          .replace(/\n+/g, "\n")
          .replace(/(\d+)\n(\d{2}:\d{2}:\d{2},\d{3})/g, "\n\n$1\n$2")
          .trim() + "\n\n"
      );
    } catch (e) {
      logger.error(`An error occurred in content text preprocessing: ${e}`);
      return "";
    }
  }

function splitIntoChunks(captions, maxLineCount, maxWordCount) {
  let chunks = [];
  let currentChunk = [];
  let currentWordCount = 0;

  for (let caption of captions) {
    const captionWordCount = caption.content.split(/\s+/).length;

    if (currentChunk.length >= maxLineCount || currentWordCount + captionWordCount > maxWordCount) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentWordCount = 0;
    }

    currentChunk.push(caption);
    currentWordCount += captionWordCount;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

async function translateChunk(chunk, args) {
  const chunkText = subsrt.build(chunk, { format: 'srt', eol: '\n' });
  const translatedText = await callPathway("translate_subtitle_helper", {
    ...args,
    text: chunkText,
    async: false,
  });

  return subsrt.parse(preprocessStr(translatedText), { format: 'srt', eol: '\n' });
}

async function myResolver(args) {
  try {
    const { text, format } = args;
    const captions = subsrt.parse(preprocessStr(text), { format, verbose: true, eol: "\n" });
    const maxLineCount = 1000;
    const maxWordCount = 10000;

    const chunks = splitIntoChunks(captions, maxLineCount, maxWordCount);
    let translatedCaptions = [];

    for (let chunk of chunks) {
      const translatedChunk = await translateChunk(chunk, args);
      translatedCaptions = translatedCaptions.concat(translatedChunk);
    }

    return subsrt.build(translatedCaptions, { format: format === "vtt" ? "vtt" : "srt", eol: "\n" }).trim() + "\n";
  } catch (e) {
    logger.error(`An error occurred in subtitle translation, will try direct translation next: ${e}`);
    try {
      return await callPathway("translate_gpt4", {...args, async: false});
    } catch (e) {
      logger.error(`An error occurred in subtitle translation: ${e}`);
      return "";
    }
  }
}

export default {
  inputParameters: {
    to: `Arabic`,
    tokenRatio: 0.2,
    format: `srt`,
  },
  inputChunkSize: 500,
  model: "oai-gpt4o",
  enableDuplicateRequests: false,
  timeout: 3600,
  executePathway: async ({ args }) => {
    return await myResolver(args);
  },
};