import { config } from "../../../config.js";
import {
  deleteTempPath,
  downloadFile,
  getMediaChunks,
  markCompletedForCleanUp,
} from "../../../lib/fileUtils.js";
import { publishRequestProgress } from "../../../lib/redisSubscription.js";
import subvibe from "@aj-archipelago/subvibe";
import { buildSegments, segmentsToCues } from "../transcribe_xai/segments.js";
import { transcribeGeminiFile, transcribeScribeUrl } from "./providers.js";

export function normalizeMediaChunk(chunk, index) {
  const url =
    typeof chunk === "string"
      ? chunk
      : [chunk.url, chunk.downloadUrl, chunk.signedUrl, chunk.uri].find(
          (value) => /^https?:\/\//i.test(value || ""),
        );
  if (!/^https?:\/\//i.test(url || ""))
    throw new Error(
      "Transcription requires an uploaded audio/video file with an HTTP(S) chunk URL",
    );
  const offset =
    typeof chunk === "string"
      ? index * 500
      : Number(chunk.offset ?? chunk.start ?? index * 500);
  if (!Number.isFinite(offset) || offset < 0)
    throw new Error("Invalid transcription chunk offset");
  return { url, offset };
}
export function formatTranscript(parts, args) {
  const text = parts
    .map((p) => p.text)
    .join(" ")
    .trim();
  const timed =
    ["srt", "vtt", "json"].includes(args.responseFormat) ||
    args.wordTimestamped;
  if (
    timed &&
    parts.some((part) =>
      part.words.some(
        (word) =>
          !Number.isFinite(word.start) ||
          !Number.isFinite(word.end) ||
          word.start < 0 ||
          word.end < word.start,
      ),
    )
  )
    throw new Error("Provider returned invalid word timestamps");
  const words = parts.flatMap((part) =>
    part.words.map((word) => ({
      ...word,
      start: word.start + part.offset,
      end: word.end + part.offset,
      // Speaker identities are local to each provider chunk, not globally matched.
      ...(word.speaker ? { speaker: `${part.index + 1}:${word.speaker}` } : {}),
    })),
  );
  if (timed && parts.some((part) => part.text?.trim() && !part.words.length))
    throw new Error(
      "Provider returned text without the requested word timestamps",
    );
  if (
    timed &&
    words.some(
      (word) =>
        !Number.isFinite(word.start) ||
        !Number.isFinite(word.end) ||
        word.start < 0 ||
        word.end < word.start,
    )
  )
    throw new Error("Provider returned invalid word timestamps");
  if (args.responseFormat === "json") return JSON.stringify({ text, words });
  if (timed)
    return subvibe.build(
      segmentsToCues(buildSegments(words, args)),
      args.responseFormat === "srt" ? "srt" : "vtt",
    );
  return text;
}
export function createMediaTranscriptionPathway(provider) {
  return {
    prompt: "{{text}}",
    model: "oai-whisper",
    timeout: 3600,
    enableDuplicateRequests: false,
    inputParameters: {
      file: "",
      language: "",
      responseFormat: "text",
      wordTimestamped: false,
      maxLineWidth: 0,
      maxLineCount: 0,
      maxWordsPerLine: 0,
      highlightWords: false,
      contextId: "",
      diarize: false,
      vocabulary: { type: "array", items: { type: "string" } },
    },
    executePathway: async ({ args, resolver }) => {
      if (!args.file) throw new Error("file is required");
      const key =
        provider === "gemini"
          ? config.get("geminiApiKey")
          : process.env.REPLICATE_API_KEY;
      if (!key)
        throw new Error(
          `${provider === "gemini" ? "GEMINI_API_KEY" : "REPLICATE_API_KEY"} is required`,
        );
      const requestId = resolver?.requestId;
      const paths = [];
      const parts = [];
      try {
        const chunks = (
          await getMediaChunks(args.file, requestId, args.contextId)
        ).map(normalizeMediaChunk);
        if (!chunks.length)
          throw new Error("Media helper returned no transcription chunks");
        for (const [index, chunk] of chunks.entries()) {
          const signal = AbortSignal.timeout(20 * 60 * 1000);
          let result;
          if (provider === "gemini") {
            const localPath = await downloadFile(chunk.url, {
              timeoutMs: 60000,
            });
            paths.push(localPath);
            const extension = new URL(chunk.url).pathname
              .split(".")
              .pop()
              .toLowerCase();
            const mime =
              {
                mp3: "audio/mpeg",
                wav: "audio/wav",
                flac: "audio/flac",
                m4a: "audio/mp4",
                mp4: "audio/mp4",
                ogg: "audio/ogg",
                webm: "audio/webm",
              }[extension] || "audio/mpeg";
            result = await transcribeGeminiFile(
              localPath,
              mime,
              args,
              key,
              signal,
            );
          } else
            result = await transcribeScribeUrl(chunk.url, args, key, signal);
          parts.push({ ...result, offset: chunk.offset, index });
          if (requestId)
            await publishRequestProgress({
              requestId,
              progress: (index + 1) / (chunks.length + 1),
              data: null,
            });
        }
        return formatTranscript(parts, args);
      } finally {
        await Promise.all(
          paths.map((path) => deleteTempPath(path).catch(() => {})),
        );
        if (requestId) await markCompletedForCleanUp(requestId, args.contextId);
      }
    },
  };
}
