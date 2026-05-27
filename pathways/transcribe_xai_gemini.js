import transcribeGemini from "./transcribe_gemini.js";
import logger from "../lib/logger.js";
import subvibe from "@aj-archipelago/subvibe";
import { alignWords } from "./shared/transcribe_xai/alignment.js";
import {
  buildSegments,
  callXaiStt,
  createXaiProgressReporter,
  getXaiSttUrl,
  getXaiChunks,
  mapChunksWithConcurrency,
  mergeOverlappedChunks,
  redactUrlForLog,
  segmentsToCues,
  withChunkRetry,
} from "./shared/transcribe_xai/shared.js";

const DEFAULT_CHUNK_OVERLAP_SECONDS = 30;
const MAX_CHUNK_OVERLAP_SECONDS = 30;

function getChunkOverlapSeconds() {
  const parsed = Number.parseFloat(
    process.env.XAI_GEMINI_CHUNK_OVERLAP_SECONDS,
  );
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_CHUNK_OVERLAP_SECONDS;
  }
  return Math.min(parsed, MAX_CHUNK_OVERLAP_SECONDS);
}

const transcribeXaiGemini = {
  ...transcribeGemini,
  inputParameters: {
    ...transcribeGemini.inputParameters,
    aiName: "Jarvis",
  },
  // Required by Cortex PathwayResolver and used for Gemini transcript text.
  // xAI supplies word timing; Gemini remains the text provider in this hybrid.
  model: process.env.XAI_GEMINI_TRANSCRIBE_MODEL || "gemini-flash-3-vision",
  timeout: 3600,

  executePathway: async function ({ args, runAllPrompts, resolver }) {
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
    const needTimestamps = fmt === "srt" || fmt === "vtt" || wordTimestamped;

    const { requestId } = resolver || {};
    logger.info(
      `[xai_gemini] start file=${redactUrlForLog(file)} format=${responseFormat} ` +
        `wordTimestamped=${wordTimestamped} mlw=${maxLineWidth} mwp=${maxWordsPerLine} model=${this.model}`,
    );

    // Plain-text fast path: skip the per-chunk alignment, just run Gemini once.
    if (!needTimestamps) {
      const geminiText = await transcribeGemini.executePathway.call(this, {
        args: {
          ...args,
          responseFormat: "text",
          wordTimestamped: false,
          maxLineWidth: 0,
          maxLineCount: 0,
          maxWordsPerLine: 0,
        },
        runAllPrompts,
        resolver,
      });
      return String(geminiText || "");
    }

    logger.info(
      `[xai_gemini] xai stt endpoint=${redactUrlForLog(getXaiSttUrl())}`,
    );

    const progress = createXaiProgressReporter(requestId, {
      logger,
      label: "[xai_gemini]",
    });
    progress.start();

    let perChunk;
    const chunkOverlapSeconds = getChunkOverlapSeconds();
    try {
      // Get one chunk plan for both providers. Gemini may prefer gcs/uri, but
      // xAI must get fetchable URLs for the same audio windows.
      const chunks = await getXaiChunks(file, requestId, contextId, undefined, {
        chunkOverlapSeconds,
      });
      progress.setTotalSteps(chunks.length);
      logger.info(
        `[xai_gemini] processing ${chunks.length} chunk(s) ` +
          `with ${chunkOverlapSeconds}s overlap`,
      );

      // Per-chunk Gemini + xAI. Each chunk's Gemini text is bounded in time by
      // the chunk's offset/duration, so anchors cannot drift across chunks.
      perChunk = await mapChunksWithConcurrency(chunks, async (c, idx) => {
        const chunkUrl = c.url;
        const geminiFile = c.geminiFile || chunkUrl;
        const offset = c.offset || 0;

        const [gText, xRaw] = await withChunkRetry(
          `chunk ${idx + 1}/${chunks.length}`,
          ({ signal }) =>
            Promise.all([
              transcribeGemini.executePathway.call(this, {
                args: {
                  ...args,
                  file: geminiFile,
                  responseFormat: "text",
                  wordTimestamped: false,
                  maxLineWidth: 0,
                  maxLineCount: 0,
                  maxWordsPerLine: 0,
                },
                runAllPrompts,
                resolver,
              }),
              callXaiStt(chunkUrl, language, { signal }),
            ]),
          { logger },
        );

        const gWords = String(gText || "")
          .split(/\s+/)
          .filter(Boolean);
        const xWords = xRaw.words;
        const chunkDur =
          xRaw.duration || (xWords.length ? xWords[xWords.length - 1].end : 0);

        const alignedLocal = alignWords(gWords, xWords, chunkDur, { logger });
        const anchorsCount = alignedLocal.filter(
          (w) => w.type === "anchor",
        ).length;
        logger.info(
          `[xai_gemini] chunk ${idx + 1}/${chunks.length} ` +
            `(@${offset}s): gem=${gWords.length}w xai=${xWords.length}w ` +
            `anchors=${anchorsCount}/${alignedLocal.length} ` +
            `(${((anchorsCount / Math.max(1, alignedLocal.length)) * 100).toFixed(0)}%)`,
        );
        progress.completeStep();

        const words = alignedLocal.map((w) => ({
          ...w,
          start: w.start + offset,
          end: w.end + offset,
        }));

        return {
          words,
          start: offset,
          end: offset + chunkDur,
        };
      });
    } finally {
      progress.stop();
    }

    const aligned = mergeOverlappedChunks(perChunk, { logger });
    const totalAnchors = aligned.filter((w) => w.type === "anchor").length;
    logger.info(
      `[xai_gemini] total: ${totalAnchors}/${aligned.length} anchors ` +
        `(${((totalAnchors / Math.max(1, aligned.length)) * 100).toFixed(0)}%)`,
    );

    if (!aligned.length) {
      logger.warn("[xai_gemini] no words produced");
      return "";
    }

    const segs = buildSegments(
      aligned,
      { wordTimestamped, maxLineWidth, maxWordsPerLine },
      { trustGaps: false },
    );
    const cues = segmentsToCues(segs);
    if (fmt === "srt" || fmt === "vtt") return subvibe.build(cues, fmt);
    if (wordTimestamped) return subvibe.build(cues, "vtt");
    return aligned.map((w) => w.text).join(" ");
  },
};

if (transcribeGemini.resolver) {
  transcribeXaiGemini.resolver = transcribeGemini.resolver.bind(
    transcribeXaiGemini,
  );
}

export default transcribeXaiGemini;
