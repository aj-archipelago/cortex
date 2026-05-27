import {
  getMediaChunks,
  isYoutubeUrl,
} from "../../../lib/fileUtils.js";
import { publishRequestProgress } from "../../../lib/redisSubscription.js";
export { buildSegments, segmentsToCues } from "./segments.js";

const DEFAULT_XAI_STT_URL = "https://api.x.ai/v1/stt";
const CHUNK_DURATION_SECONDS = 500;
const DEFAULT_CHUNK_CONCURRENCY = 4;
const MAX_CHUNK_CONCURRENCY = 8;
const DEFAULT_CHUNK_RETRIES = 2;
const MAX_CHUNK_RETRIES = 5;
const DEFAULT_CHUNK_TIMEOUT_MS = 600000;
const MAX_CHUNK_TIMEOUT_MS = 1800000;

function parsePositiveInt(value, fallback, max = Infinity) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, max)
    : fallback;
}

function parseNonNegativeInt(value, fallback, max = Infinity) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.min(parsed, max)
    : fallback;
}

function getChunkConcurrency() {
  return parsePositiveInt(
    process.env.XAI_TRANSCRIBE_CHUNK_CONCURRENCY,
    DEFAULT_CHUNK_CONCURRENCY,
    MAX_CHUNK_CONCURRENCY,
  );
}

function getChunkRetries() {
  return parseNonNegativeInt(
    process.env.XAI_TRANSCRIBE_CHUNK_RETRIES,
    DEFAULT_CHUNK_RETRIES,
    MAX_CHUNK_RETRIES,
  );
}

function getChunkTimeoutMs() {
  return parsePositiveInt(
    process.env.XAI_TRANSCRIBE_CHUNK_TIMEOUT_MS,
    DEFAULT_CHUNK_TIMEOUT_MS,
    MAX_CHUNK_TIMEOUT_MS,
  );
}

export function redactUrlForLog(value) {
  if (!value || typeof value !== "string") return value;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}${url.search ? "?***REDACTED***" : ""}`;
  } catch {
    return value;
  }
}

export function getXaiSttUrl() {
  return process.env.XAI_STT_URL || DEFAULT_XAI_STT_URL;
}

export function redactTextForLog(value) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/g, "Bearer ***REDACTED***")
    .replace(/Basic\s+[A-Za-z0-9+/=]+/g, "Basic ***REDACTED***")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "***REDACTED_AWS_KEY***")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "***REDACTED_JWT***",
    )
    .replace(/https?:\/\/[^\s"'<>]+/g, (url) => redactUrlForLog(url))
    .replace(
      /(subscription-key=|sig=|token=|api[_-]?key=|password=)[^&\s"']+/gi,
      "$1***REDACTED***",
    );
}

export function createXaiProgressReporter(
  requestId,
  { logger, totalSteps = 1, label = "[xai]" } = {},
) {
  if (!requestId) {
    return {
      setTotalSteps() {},
      start() {},
      completeStep() {},
      stop() {},
    };
  }

  let completedSteps = 0;
  let partial = 0;
  let total = Math.max(1, totalSteps);
  let lastProgress = 0;
  let intervalId = null;

  const publish = (progress) => {
    const bounded = Math.max(
      lastProgress,
      Math.max(0.001, Math.min(progress, 0.99)),
    );
    lastProgress = bounded;
    logger?.info?.(`${label} progress for ${requestId}: ${bounded}`);
    publishRequestProgress({ requestId, progress: bounded, data: null });
  };

  return {
    setTotalSteps(nextTotal) {
      total = Math.max(1, nextTotal);
    },
    start() {
      publish(0.001);
      intervalId = setInterval(() => {
        partial = Math.min(partial + 0.02, 0.95);
        publish((completedSteps + partial) / total);
      }, 3000);
    },
    completeStep() {
      partial = 0;
      completedSteps++;
      if (completedSteps < total) publish(completedSteps / total);
    },
    stop() {
      if (intervalId) clearInterval(intervalId);
      intervalId = null;
    },
  };
}

export async function callXaiStt(fileUrl, language, { signal } = {}) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error("XAI_API_KEY is not set");

  const fd = new FormData();
  fd.append("url", fileUrl);
  if (language) fd.append("language", language);
  fd.append("diarize", "false");
  fd.append("format", "false");

  const resp = await fetch(getXaiSttUrl(), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd,
    signal,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(
      `xAI STT failed: ${resp.status} ${redactTextForLog(body).slice(0, 300)}`,
    );
  }

  let json;
  try {
    json = await resp.json();
  } catch (error) {
    throw new Error(`xAI STT returned invalid JSON: ${error.message}`);
  }
  const words = (json.words || [])
    .filter((w) => (w.text || "").trim())
    .map((w) => ({
      text: String(w.text).trim(),
      start: Number(w.start),
      end: Number(w.end),
    }))
    .filter(
      (w) =>
        Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start,
    );

  return { text: json.text || "", words, duration: Number(json.duration) || 0 };
}

function isRetryableChunkError(error) {
  const message = String(error?.message || error || "");
  if (/XAI_API_KEY|requires fetchable|not enabled|invalid url/i.test(message)) {
    return false;
  }
  return (
    error?.name === "AbortError" ||
    error?.name === "ChunkTimeoutError" ||
    /timed out|invalid JSON|fetch failed|network|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(
      message,
    ) ||
    /\b(408|409|425|429|5\d\d)\b/.test(message)
  );
}

async function withChunkTimeout(label, operation, timeoutMs) {
  const controller = new AbortController();
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      const timeoutError = new Error(`${label} timed out after ${timeoutMs}ms`);
      timeoutError.name = "ChunkTimeoutError";
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      operation({ signal: controller.signal }),
      timeoutPromise,
    ]);
  } catch (error) {
    if (controller.signal.aborted && error.name !== "ChunkTimeoutError") {
      const timeoutError = new Error(`${label} timed out after ${timeoutMs}ms`);
      timeoutError.name = "ChunkTimeoutError";
      timeoutError.cause = error;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function retryDelayMs(attempt) {
  const baseMs = 750 * 2 ** attempt;
  const jitterMs = Math.floor(Math.random() * 250);
  return Math.min(baseMs + jitterMs, 5000);
}

export async function withChunkRetry(label, operation, { logger } = {}) {
  const retries = getChunkRetries();
  const timeoutMs = getChunkTimeoutMs();

  for (let attempt = 0; ; attempt++) {
    try {
      return await withChunkTimeout(label, operation, timeoutMs);
    } catch (error) {
      const retryable = isRetryableChunkError(error);
      if (!retryable || attempt >= retries) {
        throw error;
      }

      const delayMs = retryDelayMs(attempt);
      logger?.warn?.(
        `[xai] ${label} failed, retrying ${attempt + 1}/${retries} ` +
          `in ${delayMs}ms: ${redactTextForLog(error.message)}`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function mapChunksWithConcurrency(chunks, mapper) {
  const concurrency = Math.min(getChunkConcurrency(), chunks.length);
  const results = new Array(chunks.length);
  let nextIndex = 0;
  let failed = false;

  async function worker() {
    for (;;) {
      if (failed) return;
      const index = nextIndex++;
      if (index >= chunks.length) return;
      try {
        results[index] = await mapper(chunks[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

function isXaiFetchableUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return ["http:", "https:"].includes(parsed.protocol) && !isYoutubeUrl(url);
}

function getPreferredXaiUrl(...candidates) {
  return candidates.find(isXaiFetchableUrl) || candidates.find(Boolean);
}

function assertXaiFetchableUrl(url) {
  if (!isXaiFetchableUrl(url)) {
    throw new Error(
      "xAI STT requires fetchable HTTP(S) media chunk URLs. Configure the media helper or pass a transcriptionUrl.",
    );
  }
}

function normalizeChunk(chunk, index, fallbackFile) {
  const fallbackOffset = index * CHUNK_DURATION_SECONDS;
  if (typeof chunk === "string") {
    return { url: chunk, geminiFile: chunk, offset: fallbackOffset };
  }

  const c = chunk || {};
  const url = getPreferredXaiUrl(
    c.url,
    c.uri,
    c.downloadUrl,
    c.signedUrl,
    c.gcs,
  );
  const offset = Number(c.offset ?? c.start ?? fallbackOffset);

  return {
    url,
    geminiFile: c.gcs || c.uri || c.url || url,
    offset: Number.isFinite(offset) ? offset : fallbackOffset,
  };
}

export async function getXaiChunks(
  file,
  requestId,
  contextId = null,
  getChunks = getMediaChunks,
  options = {},
) {
  const mediaChunks = await getChunks(file, requestId, contextId, options);
  if (!Array.isArray(mediaChunks) || !mediaChunks.length) {
    throw new Error("Media helper returned no chunks for xAI transcription");
  }

  const chunks = mediaChunks.map((chunk, index) =>
    normalizeChunk(chunk, index, file),
  );

  if (!chunks.length || chunks.some((chunk) => !chunk.url)) {
    throw new Error(
      "Media helper returned no fetchable chunk URLs for xAI transcription",
    );
  }

  chunks.forEach((chunk) => assertXaiFetchableUrl(chunk.url));
  if (
    chunks.length === 1 &&
    chunks[0].url === file &&
    !file.startsWith("gs://") &&
    !isYoutubeUrl(file)
  ) {
    throw new Error(
      "xAI transcription requires media-helper chunk URLs; refusing to use the original media URL as a fallback.",
    );
  }

  return chunks;
}

function wordMidpoint(word) {
  return ((Number(word.start) || 0) + (Number(word.end) || 0)) / 2;
}

function getOverlapBoundary(leftChunk, rightChunk) {
  const leftEnd = Number(leftChunk?.end);
  const rightStart = Number(rightChunk?.start);
  if (!Number.isFinite(leftEnd) || !Number.isFinite(rightStart)) return null;
  if (rightStart >= leftEnd) return null;
  return rightStart + (leftEnd - rightStart) / 2;
}

export function mergeOverlappedChunks(chunks, { logger } = {}) {
  const merged = [];
  let trimmed = 0;

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    const words = Array.isArray(chunk) ? chunk : chunk.words || [];
    if (!words.length) continue;

    const startBoundary = getOverlapBoundary(chunks[index - 1], chunk);
    const endBoundary = getOverlapBoundary(chunk, chunks[index + 1]);
    const kept = words.filter((word) => {
      const midpoint = wordMidpoint(word);
      return (
        (startBoundary == null || midpoint >= startBoundary) &&
        (endBoundary == null || midpoint < endBoundary)
      );
    });

    trimmed += words.length - kept.length;
    merged.push(...kept);
  }

  if (trimmed) {
    logger?.info?.(`[xai_gemini] trimmed ${trimmed} overlapped word(s)`);
  }

  return merged;
}
