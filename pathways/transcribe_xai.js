import transcribeGemini from "./transcribe_gemini.js";
import logger from "../lib/logger.js";
import subvibe from "@aj-archipelago/subvibe";
import {
  buildSegments,
  callXaiStt,
  createXaiProgressReporter,
  getXaiSttUrl,
  getXaiChunks,
  mapChunksWithConcurrency,
  redactUrlForLog,
  segmentsToCues,
  withChunkRetry,
} from "./shared/transcribe_xai/shared.js";

const transcribeXai = {
  // Inherit input parameters / resolver from transcribe_gemini for shape parity
  // with the other transcribe pathways.
  ...transcribeGemini,
  inputParameters: {
    ...transcribeGemini.inputParameters,
    aiName: "Jarvis",
  },
  // Cortex PathwayResolver requires a configured model even when executePathway
  // performs the external xAI call itself. This value preserves the inherited
  // transcribe_gemini pathway shape; xAI-only requests never call this model.
  model: "gemini-flash-35-vision",
  timeout: 3600,

  executePathway: async function ({ args, resolver }) {
    const {
      file,
      language,
      responseFormat = "text",
      wordTimestamped = false,
      maxLineWidth = 0,
      maxWordsPerLine = 0,
      contextId = null,
    } = args || {};

    if (!file) throw new Error("file is required");
    const fmt = String(responseFormat).toLowerCase();
    const { requestId } = resolver || {};

    logger.info(
      `[xai] start file=${redactUrlForLog(file)} format=${responseFormat} ` +
        `wordTimestamped=${wordTimestamped} mlw=${maxLineWidth} mwp=${maxWordsPerLine}`,
    );
    logger.info(`[xai] stt endpoint=${redactUrlForLog(getXaiSttUrl())}`);

    const progress = createXaiProgressReporter(requestId, {
      logger,
      label: "[xai]",
    });
    progress.start();

    let perChunk;
    try {
      // xAI needs fetchable HTTP(S) URLs and shorter chunks for long media.
      const chunks = await getXaiChunks(file, requestId, contextId);
      progress.setTotalSteps(chunks.length);
      logger.info(`[xai] processing ${chunks.length} chunk(s)`);

      perChunk = await mapChunksWithConcurrency(chunks, async (c, idx) => {
        const offset = c.offset || 0;
        const r = await withChunkRetry(
          `chunk ${idx + 1}/${chunks.length}`,
          ({ signal }) => callXaiStt(c.url, language, { signal }),
          { logger },
        );
        logger.info(
          `[xai] chunk ${idx + 1}/${chunks.length} (@${offset}s): ` +
            `${r.words.length}w dur=${r.duration.toFixed(1)}s`,
        );
        progress.completeStep();
        return {
          text: r.text,
          words: r.words.map((w) => ({
            text: w.text,
            start: w.start + offset,
            end: w.end + offset,
          })),
        };
      });
    } finally {
      progress.stop();
    }

    const allWords = perChunk.flatMap((p) => p.words);
    const allText = perChunk
      .map((p) => p.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    logger.info(`[xai] total: ${allWords.length} words`);

    if (fmt === "srt" || fmt === "vtt") {
      const segs = buildSegments(allWords, {
        wordTimestamped,
        maxLineWidth,
        maxWordsPerLine,
      });
      return subvibe.build(segmentsToCues(segs), fmt);
    }
    if (wordTimestamped) {
      const segs = buildSegments(allWords, { wordTimestamped: true });
      return subvibe.build(segmentsToCues(segs), "vtt");
    }
    return allText || allWords.map((w) => w.text).join(" ");
  },
};

if (transcribeGemini.resolver) {
  transcribeXai.resolver = transcribeGemini.resolver.bind(transcribeXai);
}

export default transcribeXai;
