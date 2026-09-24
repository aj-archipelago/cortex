import { getMediaChunks, markCompletedForCleanUp } from "../../../lib/fileUtils.js";
import { publishRequestProgress } from "../../../lib/redisSubscription.js";
import logger from "../../../lib/logger.js";
import { buildReplicateInput, predictTranscription } from "./client.js";
import { normalizeReplicateOutput, formatReplicateTranscript, validateReplicateFormat } from "./format.js";

export function normalizeReplicateChunk(chunk, index) {
  const candidates = typeof chunk === "string" ? [chunk] : [chunk?.url, chunk?.downloadUrl, chunk?.signedUrl, chunk?.uri, chunk?.gcs];
  const url = candidates.find(value => typeof value === "string" && /^https?:\/\//i.test(value));
  const offset = typeof chunk === "string" ? index * 500 : chunk?.offset ?? chunk?.start ?? index * 500;
  if (!url || !Number.isFinite(offset) || offset < 0) throw new Error("Media helper returned an invalid Replicate audio chunk");
  return { url, offset };
}

export async function executeReplicateTranscription(provider, { args, resolver }, dependencies = {}) {
  const getChunks = dependencies.getMediaChunks || getMediaChunks;
  const cleanup = dependencies.cleanup || markCompletedForCleanUp;
  const predict = dependencies.predict || predictTranscription;
  const publish = dependencies.publish || publishRequestProgress;
  if (!args?.file) throw new Error("file is required");
  validateReplicateFormat(args);
  // Validate capabilities before preparing media or submitting a billable job.
  buildReplicateInput(provider, "https://validation.invalid/audio.wav", args);
  const { requestId } = resolver || {};
  const contextId = args.contextId || null;
  const results = [];
  const jobs = new Map();
  let preserveInputs = false;
  let total = 1;
  let progress = 0;
  const reportProgress = () => {
    if (!requestId) return;
    progress = Math.min(0.99, Math.max(progress, results.length / total) + 0.005);
    publish({ requestId, progress, data: null });
  };
  const interval = requestId ? setInterval(reportProgress, 3000) : null;
  try {
    const chunks = (await getChunks(args.file, requestId, contextId)).map(normalizeReplicateChunk);
    if (!chunks.length) throw new Error("Media helper returned no audio chunks");
    total = chunks.length;
    logger.info(`[replicate-${provider}] processing ${chunks.length} audio chunk(s)`);
    // Match the current Whisper route's four-chunk batches. Wait for siblings
    // to settle before cleanup, including when one prediction fails.
    for (let i = 0; i < chunks.length; i += 4) {
      const batch = await Promise.allSettled(chunks.slice(i, i + 4).map(async chunk => {
        if (!jobs.has(chunk.url)) jobs.set(chunk.url, predict(provider, chunk.url, args, {
          isCanceled: () => resolver?.isCanceled?.() || false,
        }));
        const output = await jobs.get(chunk.url);
        return normalizeReplicateOutput(output, chunk.offset);
      }));
      for (const result of batch) {
        if (result.status === "rejected" && result.reason?.inputMayBeInUse) preserveInputs = true;
      }
      const failed = batch.find(result => result.status === "rejected");
      if (failed) throw failed.reason;
      results.push(...batch.map(result => result.value));
      if (results.length < chunks.length) reportProgress();
    }
    return formatReplicateTranscript(results, args);
  } finally {
    clearInterval(interval);
    if (!preserveInputs) await cleanup(requestId, contextId);
    else logger.warn(`[replicate-${provider}] retaining audio for an unconfirmed prediction; deferred to storage expiry`);
  }
}

export function replicateTranscriptionPathway(provider) {
  return {
    prompt: "{{text}}",
    // Required by Cortex even though this pathway calls its provider directly.
    model: `replicate-${provider}`,
    inputParameters: {
      file: "", language: "", responseFormat: "text", wordTimestamped: false,
      highlightWords: false, maxLineWidth: 0, maxLineCount: 0, maxWordsPerLine: 0, contextId: "",
    },
    timeout: 3600,
    enableDuplicateRequests: false,
    executePathway: context => executeReplicateTranscription(provider, context),
  };
}
