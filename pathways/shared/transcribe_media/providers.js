// Provider contracts: Google Interactions transcription and Replicate Scribe v2.
// These routes never call ElevenLabs or OpenAI directly.
import fs from "node:fs/promises";
const GOOGLE = "https://generativelanguage.googleapis.com";
const REPLICATE = "https://api.replicate.com/v1";

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok)
    throw new Error(
      `Transcription provider request failed (${response.status})`,
    );
  return response.json();
}
const pause = (ms, signal) =>
  new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error("Transcription timed out"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });

export function buildGeminiTranscriptionRequest(uri, mimeType, args) {
  const timestamps =
    args.wordTimestamped ||
    ["vtt", "srt", "json"].includes(args.responseFormat);
  const vocabulary = (args.vocabulary || [])
    .map((term) => String(term).trim())
    .filter(Boolean);
  if (vocabulary.length > 1000)
    throw new Error("At most 1000 vocabulary terms are supported");
  if (vocabulary.length && (timestamps || args.diarize))
    throw new Error(
      "Gemini vocabulary hints cannot be combined with timestamps or speaker labels",
    );
  const language = args.language?.trim();
  return {
    model: "gemini-3.5-transcribe",
    input: [{ type: "audio", uri, mime_type: mimeType }],
    generation_config: {
      transcription_config: {
        ...(language && language !== "auto"
          ? { language_codes: [language] }
          : {}),
        ...(vocabulary.length ? { custom_vocabulary: vocabulary } : {}),
        mode: {
          type: "verbatim",
          ...(timestamps ? { timestamp_granularities: ["word"] } : {}),
          ...(args.diarize ? { diarization_mode: "speaker" } : {}),
        },
      },
    },
  };
}
const seconds = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+(\.\d+)?s$/.test(value))
    return Number(value.slice(0, -1));
  return NaN;
};
export function parseGeminiTranscription(result) {
  if (result.status && result.status !== "completed")
    throw new Error(`Gemini transcription did not complete (${result.status})`);
  const content = (result.steps || [])
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content || []);
  const words = content
    .flatMap((part) => part.annotations || [])
    .filter((a) => a.type === "word_info")
    .map((a) => ({
      text: a.text,
      start: seconds(a.start_offset),
      end: seconds(a.end_offset),
      speaker: a.speaker,
    }));
  return {
    text:
      result.output_text ||
      content
        .filter((part) => part.type === "text")
        .map((part) => part.text || "")
        .join(" "),
    words,
  };
}

export async function transcribeGeminiFile(
  localPath,
  mimeType,
  args,
  apiKey,
  signal,
) {
  if (!apiKey)
    throw new Error("GEMINI_API_KEY is required for Gemini 3.5 Transcribe");
  // Validate options before uploading any user media.
  buildGeminiTranscriptionRequest("pending", mimeType, args);
  const audio = await fs.readFile(localPath);
  const headers = { "x-goog-api-key": apiKey };
  const start = await fetch(`${GOOGLE}/upload/v1beta/files`, {
    method: "POST",
    signal,
    headers: {
      ...headers,
      "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(audio.length),
      "X-Goog-Upload-Header-Content-Type": mimeType,
    },
    body: JSON.stringify({ file: { display_name: "transcription-chunk" } }),
  });
  if (!start.ok) throw new Error(`Gemini file upload failed (${start.status})`);
  const upload = start.headers.get("x-goog-upload-url");
  if (!upload || new URL(upload).origin !== GOOGLE)
    throw new Error("Unexpected Gemini upload endpoint");
  let file;
  try {
    ({ file } = await jsonRequest(upload, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Length": String(audio.length),
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
      },
      body: audio,
      signal,
    }));
    if (!/^files\/[a-zA-Z0-9_-]+$/.test(file?.name || ""))
      throw new Error("Invalid Gemini file response");
    while (file.state === "PROCESSING") {
      await pause(2000, signal);
      file = await jsonRequest(`${GOOGLE}/v1beta/${file.name}`, {
        headers,
        signal,
      });
    }
    if (file.state === "FAILED" || !file.uri)
      throw new Error("Gemini could not process the audio file");
    const result = await jsonRequest(`${GOOGLE}/v1beta/interactions`, {
      method: "POST",
      signal,
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(
        buildGeminiTranscriptionRequest(file.uri, mimeType, args),
      ),
    });
    return parseGeminiTranscription(result);
  } finally {
    // Delete only the temporary file created by this invocation, with a fresh timeout.
    if (/^files\/[a-zA-Z0-9_-]+$/.test(file?.name || ""))
      await fetch(`${GOOGLE}/v1beta/${file.name}`, {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(10000),
      }).catch(() => {});
  }
}

export function buildScribeInput(url, args) {
  const terms = args.vocabulary || [];
  if (
    terms.length > 1000 ||
    terms.some(
      (term) =>
        typeof term !== "string" || term.length > 50 || term.includes(","),
    )
  )
    throw new Error(
      "Scribe vocabulary supports at most 1000 terms of 50 characters, without commas",
    );
  return {
    audio: url,
    language_code: args.language || "auto",
    diarize: args.diarize ?? false,
    timestamps_granularity: "word",
    tag_audio_events: false,
    keyterms: terms.join(","),
    no_verbatim: false,
  };
}
export async function transcribeScribeUrl(url, args, apiKey, signal) {
  if (!apiKey) throw new Error("REPLICATE_API_KEY is required for Scribe v2");
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  let result = await jsonRequest(
    `${REPLICATE}/models/elevenlabs/scribe-v2/predictions`,
    {
      method: "POST",
      signal,
      headers: { ...headers, Prefer: "wait=60" },
      body: JSON.stringify({ input: buildScribeInput(url, args) }),
    },
  );
  const id = result.id;
  if (
    !["succeeded", "failed", "canceled"].includes(result.status) &&
    !/^[a-zA-Z0-9_-]+$/.test(id || "")
  )
    throw new Error("Invalid Scribe prediction ID");
  while (["starting", "processing"].includes(result.status)) {
    await pause(2000, signal);
    result = await jsonRequest(`${REPLICATE}/predictions/${id}`, {
      headers,
      signal,
    });
  }
  if (result.status !== "succeeded" || !result.output)
    throw new Error(`Scribe transcription did not complete (${result.status})`);
  return {
    text: result.output.text || "",
    words: (result.output.words || [])
      .filter((word) => word.type === "word")
      .map((word) => ({
        text: word.text,
        start: word.start,
        end: word.end,
        speaker: word.speaker_id,
      })),
  };
}
