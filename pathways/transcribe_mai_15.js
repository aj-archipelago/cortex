import fs from "node:fs/promises";
import path from "node:path";
import logger from "../lib/logger.js";
import { publishRequestProgress } from "../lib/redisSubscription.js";
import {
  deleteTempPath,
  downloadFile,
  getMediaChunks,
  markCompletedForCleanUp,
} from "../lib/fileUtils.js";

export const MAI_TRANSCRIBE_15_MODEL = "mai-transcribe-1.5";

const DEFAULT_REGION = "eastus";
const DEFAULT_API_VERSION = "2025-10-15";
const DEFAULT_OFFSET_CHUNK_SECONDS = 500;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

const LANGUAGE_ALIASES = {
  auto: null,
  autodetect: null,
  arabic: "ar",
  ar: "ar",
  "ar-sa": "ar",
  english: "en",
  en: "en",
  "en-us": "en",
  "en-gb": "en",
  hindi: "hi",
  hi: "hi",
  punjabi: "pa",
  panjabi: "pa",
  pa: "pa",
  urdu: "ur",
  ur: "ur",
};

function normalizeLanguage(language) {
  const normalized = String(language || "").trim();
  if (!normalized) return null;
  if (Object.hasOwn(LANGUAGE_ALIASES, normalized.toLowerCase())) {
    return LANGUAGE_ALIASES[normalized.toLowerCase()];
  }
  return normalized;
}

export function buildMaiDefinition(language, model = MAI_TRANSCRIBE_15_MODEL) {
  const definition = {
    enhancedMode: {
      enabled: true,
      model,
    },
  };
  const normalizedLanguage = normalizeLanguage(language);
  if (normalizedLanguage) {
    definition.locales = [normalizedLanguage];
  }
  return JSON.stringify(definition);
}

function getMaiTranscribeUrl() {
  if (process.env.AZURE_SPEECH_TRANSCRIBE_URL) {
    return process.env.AZURE_SPEECH_TRANSCRIBE_URL;
  }
  const region = process.env.AZURE_SPEECH_REGION || DEFAULT_REGION;
  const apiVersion = process.env.AZURE_SPEECH_API_VERSION || DEFAULT_API_VERSION;
  return `https://${region}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=${apiVersion}`;
}

function getMaiSpeechKey() {
  return process.env.AZURE_SPEECH_KEY || process.env.AZURE_SPEECH_API_KEY;
}

export function extractMaiText(response) {
  const combinedText = response?.combinedPhrases
    ?.map((phrase) => phrase?.text || "")
    .filter(Boolean)
    .join(" ")
    .trim();
  if (combinedText) return combinedText;

  return (response?.phrases || [])
    .map((phrase) => phrase?.text || "")
    .filter(Boolean)
    .join(" ")
    .trim();
}

function formatTimestamp(ms, responseFormat) {
  const totalMs = Math.max(0, Math.round(Number(ms) || 0));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis = totalMs % 1000;
  const separator = responseFormat === "vtt" ? "." : ",";
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator}${String(millis).padStart(3, "0")}`;
}

export function phrasesToSubtitles(phrases = [], responseFormat = "srt") {
  const cues = phrases
    .map((phrase, index) => {
      const start = Number(phrase?.offsetMilliseconds) || 0;
      const duration = Number(phrase?.durationMilliseconds) || 0;
      const end = Math.max(start, start + duration);
      const text = String(phrase?.text || "").trim();
      if (!text) return null;
      return [
        String(index + 1),
        `${formatTimestamp(start, responseFormat)} --> ${formatTimestamp(end, responseFormat)}`,
        text,
      ].join("\n");
    })
    .filter(Boolean);

  const body = cues.join("\n\n");
  return responseFormat === "vtt" ? `WEBVTT\n\n${body}\n` : `${body}\n`;
}

export function formatMaiResult(
  { text, phrases },
  responseFormat,
  wordTimestamped,
) {
  const format = String(responseFormat || "text").toLowerCase();
  if (format === "srt" || format === "vtt") {
    return phrasesToSubtitles(phrases, format);
  }
  if (wordTimestamped) {
    return phrasesToSubtitles(phrases, "vtt");
  }
  return text;
}

async function callMaiTranscribe(localPath, { language, signal }) {
  const key = getMaiSpeechKey();
  if (!key) {
    throw new Error("AZURE_SPEECH_KEY is required for MAI transcription");
  }

  const audio = await fs.readFile(localPath);
  const form = new FormData();
  form.append("audio", new Blob([audio]), path.basename(localPath));
  form.append("definition", buildMaiDefinition(language));

  const response = await fetch(getMaiTranscribeUrl(), {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
    },
    body: form,
    signal,
  });

  const bodyText = await response.text();
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    body = { raw: bodyText };
  }

  if (!response.ok) {
    const detail =
      body?.error?.message ||
      body?.message ||
      (typeof body?.raw === "string" ? body.raw : bodyText);
    throw new Error(
      `MAI transcription failed (${response.status}): ${String(detail).slice(0, 1000)}`,
    );
  }

  return body;
}

function withTimeout(label, fn, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  return fn(ctrl.signal)
    .catch((error) => {
      if (error?.name === "AbortError") {
        throw new Error(`${label} timed out after ${timeoutMs}ms`);
      }
      throw error;
    })
    .finally(() => clearTimeout(timeout));
}

function createProgressReporter(requestId, totalSteps) {
  let completed = 0;
  return () => {
    if (!requestId || !totalSteps) return;
    completed += 1;
    if (completed >= totalSteps) return;
    publishRequestProgress({
      requestId,
      progress: completed / totalSteps,
      data: null,
    });
  };
}

function isFetchableHttpUrl(url) {
  try {
    return ["http:", "https:"].includes(new URL(String(url)).protocol);
  } catch {
    return false;
  }
}

function getPreferredChunkUrl(...candidates) {
  return candidates.find(isFetchableHttpUrl) || candidates.find(Boolean);
}

function assertFetchableChunkUrl(url) {
  if (!isFetchableHttpUrl(url)) {
    throw new Error(
      "MAI transcription requires fetchable HTTP(S) media chunk URLs",
    );
  }
}

export function normalizeMaiChunk(chunk, index) {
  const fallbackOffset = index * DEFAULT_OFFSET_CHUNK_SECONDS;
  if (typeof chunk === "string") {
    return { url: chunk, offsetSeconds: fallbackOffset };
  }

  const c = chunk || {};
  const offset = Number(c.offset ?? c.start ?? fallbackOffset);
  return {
    url: getPreferredChunkUrl(
      c.url,
      c.downloadUrl,
      c.signedUrl,
      c.uri,
      c.gcs,
    ),
    offsetSeconds: Number.isFinite(offset) ? offset : fallbackOffset,
  };
}

const transcribeMai15 = {
  prompt: "{{text}}",
  model: "oai-whisper",
  inputParameters: {
    file: "",
    language: "",
    responseFormat: "text",
    wordTimestamped: false,
    highlightWords: false,
    maxLineWidth: 0,
    maxLineCount: 0,
    maxWordsPerLine: 0,
    contextId: "",
  },
  timeout: 3600,
  enableDuplicateRequests: false,

  executePathway: async function ({ args, resolver }) {
    const {
      file,
      language,
      responseFormat = "text",
      wordTimestamped = false,
      contextId = null,
    } = args || {};

    if (!file) throw new Error("file is required");

    const { requestId } = resolver || {};
    const downloadedPaths = [];
    const allPhrases = [];
    const allText = [];

    try {
      const chunks = (await getMediaChunks(file, requestId, contextId)).map(
        normalizeMaiChunk,
      );
      if (!chunks.length) {
        throw new Error("Media helper returned no chunks for MAI transcription");
      }
      chunks.forEach((chunk) => assertFetchableChunkUrl(chunk.url));

      const markProgress = createProgressReporter(requestId, chunks.length + 1);
      markProgress();

      logger.info(
        `[mai-1.5] processing ${chunks.length} chunk(s) with ${MAI_TRANSCRIBE_15_MODEL}`,
      );

      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const localPath = await downloadFile(chunk.url);
        downloadedPaths.push(localPath);

        const result = await withTimeout(
          `MAI chunk ${i + 1}/${chunks.length}`,
          (signal) => callMaiTranscribe(localPath, { language, signal }),
        );

        const text = extractMaiText(result);
        if (text) allText.push(text);

        const offsetMs = Math.round(chunk.offsetSeconds * 1000);
        for (const phrase of result?.phrases || []) {
          allPhrases.push({
            ...phrase,
            offsetMilliseconds:
              (Number(phrase.offsetMilliseconds) || 0) + offsetMs,
          });
        }

        logger.info(
          `[mai-1.5] chunk ${i + 1}/${chunks.length}: ${text.split(/\s+/).filter(Boolean).length} words`,
        );
        markProgress();
      }

      return formatMaiResult(
        {
          text: allText.join(" ").replace(/\s+/g, " ").trim(),
          phrases: allPhrases,
        },
        responseFormat,
        wordTimestamped,
      );
    } finally {
      for (const localPath of downloadedPaths) {
        await deleteTempPath(localPath).catch(() => {});
      }
      await markCompletedForCleanUp(requestId, contextId);
    }
  },
};

export default transcribeMai15;
