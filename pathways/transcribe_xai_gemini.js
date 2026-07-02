import transcribeGemini, {
  geminiTranscriptionSafetySettings,
} from "./transcribe_gemini.js";
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
  redactTextForLog,
  redactUrlForLog,
  segmentsToCues,
  withChunkRetry,
} from "./shared/transcribe_xai/shared.js";

// ---------- Pathway ----------

const DEFAULT_CHUNK_OVERLAP_SECONDS = 30;
const MAX_CHUNK_OVERLAP_SECONDS = 30;

function splitTranscriptWords(text) {
  return String(text || "")
    .split(/\s+/)
    .filter(Boolean);
}

export function buildXaiFallbackWords(xWords) {
  return xWords.map((w, i) => {
    const next = xWords[i + 1];
    return {
      text: w.text,
      start: w.start,
      end: w.end,
      gapAfter: next ? Math.max(0, next.start - w.end) : 0,
      type: "anchor",
      source: "xai",
    };
  });
}

export async function getGeminiChunkWords({
  gTextResultPromise,
  retryGeminiTranscription,
  chunkLabel,
  logger,
}) {
  const gTextResult = await gTextResultPromise;
  let gWords =
    gTextResult.status === "fulfilled"
      ? splitTranscriptWords(gTextResult.value)
      : [];
  let issue = "";

  if (gTextResult.status === "rejected") {
    issue = "Gemini failure";
    logger?.warn?.(
      `[xai_gemini] Gemini failed for ${chunkLabel}; retrying chunk: ` +
        redactTextForLog(gTextResult.reason?.message || gTextResult.reason),
    );
  } else if (!gWords.length) {
    issue = "empty Gemini output";
    logger?.warn?.(
      `[xai_gemini] Gemini returned no text for ${chunkLabel}; retrying chunk`,
    );
  }

  if (!gWords.length) {
    try {
      gWords = splitTranscriptWords(await retryGeminiTranscription());
    } catch (error) {
      issue = "Gemini retry failure";
      logger?.warn?.(
        `[xai_gemini] Gemini retry failed for ${chunkLabel}: ` +
          redactTextForLog(error?.message || error),
      );
    }
  }

  return { words: gWords, issue };
}

function createChildResolver(parentResolver, pathway, args) {
  if (typeof parentResolver?.constructor !== "function") {
    return null;
  }

  try {
    const childResolver = new parentResolver.constructor({
      config: parentResolver.config,
      pathway,
      args,
      endpoints: parentResolver.endpoints,
    });
    childResolver.rootRequestId =
      parentResolver.rootRequestId || parentResolver.requestId || null;
    if (typeof childResolver.promptAndParse !== "function") {
      return null;
    }
    return childResolver;
  } catch {
    return null;
  }
}

export async function runWithChildResolver({
  parentResolver,
  pathway,
  args,
  run,
}) {
  const childResolver = createChildResolver(parentResolver, pathway, args);
  if (!childResolver) {
    throw new Error("Could not create isolated resolver for Gemini chunk");
  }

  const result = await run({
    runAllPrompts: childResolver.promptAndParse.bind(childResolver),
    resolver: childResolver,
  });
  if (
    (result == null || result === "") &&
    Array.isArray(childResolver.errors) &&
    childResolver.errors.length
  ) {
    throw new Error(childResolver.errors.join(", "));
  }
  return result;
}

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
  model: process.env.XAI_GEMINI_TRANSCRIBE_MODEL || "gemini-flash-35-vision",
  geminiSafetySettings: geminiTranscriptionSafetySettings,
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

    const runGeminiTranscription = (extraArgs = {}, options = {}) => {
      const geminiArgs = {
        ...args,
        allowTranscriptionFallback: false,
        async: false,
        stream: false,
        ...extraArgs,
      };
      const run = (child = {}) =>
        transcribeGemini.executePathway.call(this, {
          args: geminiArgs,
          runAllPrompts: child.runAllPrompts || runAllPrompts,
          resolver: child.resolver || resolver,
        });
      return options.isolatedResolver
        ? runWithChildResolver({
            parentResolver: resolver,
            pathway: this,
            args: geminiArgs,
            run,
          })
        : run();
    };

    // Plain-text fast path: skip the per-chunk alignment, just run Gemini once.
    if (!needTimestamps) {
      const geminiText = await runGeminiTranscription({
        responseFormat: "text",
        wordTimestamped: false,
        maxLineWidth: 0,
        maxLineCount: 0,
        maxWordsPerLine: 0,
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

    let perChunk = [];
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

      // Per-chunk Gemini + xAI keeps Gemini text bounded to the same time
      // window as the xAI timestamps, avoiding full-file timing drift.
      perChunk = await mapChunksWithConcurrency(chunks, async (c, idx) => {
        const chunkUrl = c.url;
        const geminiFile = c.geminiFile || chunkUrl;
        const offset = c.offset || 0;
        const geminiTextArgs = {
          responseFormat: "text",
          wordTimestamped: false,
          maxLineWidth: 0,
          maxLineCount: 0,
          maxWordsPerLine: 0,
        };
        const chunkLabel = `chunk ${idx + 1}/${chunks.length}`;

        const gTextResultPromise = runGeminiTranscription({
          file: geminiFile,
          ...geminiTextArgs,
        }, { isolatedResolver: true }).then(
          (value) => ({ status: "fulfilled", value }),
          (reason) => ({ status: "rejected", reason }),
        );
        const xRaw = await withChunkRetry(
          chunkLabel,
          ({ signal }) => callXaiStt(chunkUrl, language, { signal }),
          { logger },
        );
        const xWords = xRaw.words; // chunk-local timestamps
        const chunkDur =
          xRaw.duration || (xWords.length ? xWords[xWords.length - 1].end : 0);
        const { words: gWords, issue: geminiIssue } =
          await getGeminiChunkWords({
            gTextResultPromise,
            retryGeminiTranscription: () =>
              runGeminiTranscription({
                file: geminiFile,
                ...geminiTextArgs,
              }, { isolatedResolver: true }),
            chunkLabel,
            logger,
          });

        if (!gWords.length && !xWords.length) {
          logger.warn(
            `[xai_gemini] ${chunkLabel} produced no transcription words; keeping empty chunk`,
          );
          progress.completeStep();
          return { words: [], start: offset, end: offset + chunkDur };
        }

        let source = "gemini";
        let alignedLocal;
        if (!gWords.length && xWords.length) {
          source = "xai";
          alignedLocal = buildXaiFallbackWords(xWords);
          logger.warn(
            `[xai_gemini] using xAI text for ${chunkLabel} after ${geminiIssue || "no Gemini text"}`,
          );
        } else {
          // Align WITHIN this chunk (small problem, tight bounds)
          alignedLocal = alignWords(gWords, xWords, chunkDur, { logger });
        }
        const anchorsCount = alignedLocal.filter(
          (w) => w.type === "anchor",
        ).length;
        logger.info(
          `[xai_gemini] chunk ${idx + 1}/${chunks.length} ` +
            `(@${offset}s): gem=${gWords.length}w xai=${xWords.length}w ` +
            `source=${source} ` +
            `anchors=${anchorsCount}/${alignedLocal.length} ` +
            `(${((anchorsCount / Math.max(1, alignedLocal.length)) * 100).toFixed(0)}%)`,
        );
        progress.completeStep();

        // Apply chunk offset to all timestamps so they're absolute
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
    } catch (error) {
      logger.warn(
        `[xai_gemini] hybrid timing unavailable; trying fallbacks: ${redactTextForLog(error?.message || error)}`,
      );
    } finally {
      progress.stop();
    }

    const aligned = mergeOverlappedChunks(perChunk, { logger });
    const totalAnchors = aligned.filter((w) => w.type === "anchor").length;
    logger.info(
      `[xai_gemini] total: ${totalAnchors}/${aligned.length} anchors ` +
        `(${((totalAnchors / Math.max(1, aligned.length)) * 100).toFixed(0)}%)`,
    );

    if (!totalAnchors) {
      logger.warn(
        "[xai_gemini] no xAI timing anchors; using Gemini timed output",
      );
      return runGeminiTranscription();
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
