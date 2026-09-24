import { setTimeout as sleep } from "node:timers/promises";

// Pinned from the provider schemas on 2026-09-18. These are distinct models:
// Whisper exposes segment timing; WhisperX also exposes forced word alignment.
export const REPLICATE_TRANSCRIPTION_MODELS = {
  whisper: {
    model: "openai/whisper",
    version: "8099696689d249cf8b122d833c36ac3f75505c666a395ca40ef26f68e7d3d16e",
  },
  whisperx: {
    model: "victor-upmeet/whisperx",
    version: "655845d6190ef70573c669245f245892cd039df4b880a1e3a65852c09252f5cc",
  },
};
const API = "https://api.replicate.com/v1/predictions";

export function buildReplicateInput(provider, file, args = {}) {
  if (!Object.hasOwn(REPLICATE_TRANSCRIPTION_MODELS, provider)) {
    throw new Error(`Unknown Replicate transcription provider: ${provider}`);
  }
  const url = new URL(file);
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("Replicate transcription requires a fetchable HTTP(S) audio URL");
  }
  let language = String(args.language || "").trim().toLowerCase();
  language = { english: "en", arabic: "ar", hindi: "hi", urdu: "ur", punjabi: "pa" }[language] || language;
  language = language.split("-")[0];
  if (["auto", "autodetect"].includes(language)) language = "";
  const prompt = args.text ? { initial_prompt: args.text } : {};
  if (provider === "whisper") {
    if (args.wordTimestamped || args.highlightWords || args.maxLineCount > 0 || args.maxWordsPerLine > 0) {
      throw new Error("Replicate Whisper has segment timestamps only; use replicate-whisperx for word timing, highlighting, or timed line limits");
    }
    return { audio: file, language: language || "auto", transcription: "plain text", translate: false, ...prompt };
  }
  return {
    audio_file: file,
    ...(language ? { language } : {}),
    task: "transcribe",
    align_output: true,
    diarization: false,
    ...prompt,
  };
}

export async function predictTranscription(provider, file, args = {}, {
  apiKey = process.env.REPLICATE_API_KEY || process.env.REPLICATE_API_TOKEN,
  timeoutMs = 600000,
  pollMs = 1000,
  fetchImpl = fetch,
  onPrediction = () => {},
  isCanceled = () => false,
} = {}) {
  if (!apiKey) throw new Error("REPLICATE_API_KEY is required for Replicate transcription");
  const input = buildReplicateInput(provider, file, args);
  const { version } = REPLICATE_TRANSCRIPTION_MODELS[provider];
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const signal = AbortSignal.timeout(timeoutMs);
  let prediction;
  let submissionAttempted = false;
  let terminal = false;
  const request = async (url, options = {}) => {
    const response = await fetchImpl(url, { headers, signal, ...options });
    if (!response.ok) {
      // Do not propagate provider bodies: they can contain signed input URLs.
      const error = new Error(`Replicate transcription HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };
  try {
    if (isCanceled()) throw new Error("Replicate transcription canceled");
    submissionAttempted = true;
    prediction = await request(API, {
      method: "POST",
      headers: { ...headers, "Cancel-After": `${Math.ceil(timeoutMs / 1000)}s` },
      body: JSON.stringify({ version, input }),
    });
    while (true) {
      if (["succeeded", "failed", "canceled"].includes(prediction.status)) {
        terminal = true;
        onPrediction(prediction);
        if (prediction.status !== "succeeded") {
          throw new Error(`Replicate transcription ${prediction.status} (prediction ${prediction.id})`);
        }
        if (!prediction.output || typeof prediction.output !== "object") {
          throw new Error("Replicate transcription returned no structured output");
        }
        return prediction.output;
      }
      if (isCanceled()) throw new Error("Replicate transcription canceled");
      if (!/^[a-zA-Z0-9_-]+$/.test(prediction.id || "") || !["starting", "processing"].includes(prediction.status)) {
        throw new Error("Replicate transcription returned an invalid prediction");
      }
      await sleep(pollMs, undefined, { signal });
      // Construct our own trusted URL; never send credentials to a response URL.
      prediction = await request(`${API}/${prediction.id}`);
    }
  } catch (cause) {
    // A gateway timeout or conflict can leave submission outcome ambiguous.
    const rejected = [400, 401, 402, 403, 404, 405, 413, 415, 422, 429].includes(cause.status);
    let settled = terminal || (!prediction && rejected);
    if (!settled && /^[a-zA-Z0-9_-]+$/.test(prediction?.id || "")) {
      try {
        const response = await fetchImpl(`${API}/${prediction.id}/cancel`, {
          method: "POST", headers, signal: AbortSignal.timeout(10000),
        });
        if (response.ok) {
          const canceled = await response.json();
          settled = ["succeeded", "failed", "canceled"].includes(canceled.status);
        }
      } catch { /* Retain media if cancellation could not be confirmed. */ }
    }
    const error = new Error(isCanceled() ? "Replicate transcription canceled" : signal.aborted
      ? `Replicate transcription timed out after ${timeoutMs / 1000}s`
      : cause.status || terminal ? cause.message : "Replicate transcription request failed");
    // No automatic resubmission: a failed POST may already have created a job.
    error.inputMayBeInUse = submissionAttempted && !settled;
    throw error;
  }
}
