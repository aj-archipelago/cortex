import test from "ava";
import fs from "node:fs";
import { buildReplicateInput, predictTranscription, REPLICATE_TRANSCRIPTION_MODELS } from "../../../pathways/shared/transcribe_replicate/client.js";
import { normalizeReplicateOutput, formatReplicateTranscript } from "../../../pathways/shared/transcribe_replicate/format.js";
import { summarizeSrt, wordErrorRate } from "../../../helper-apps/transcribe-bench/replicate-swap.mjs";

process.env.OPENAI_API_KEY ||= "test-key";
const { executeReplicateTranscription, normalizeReplicateChunk } = await import("../../../pathways/shared/transcribe_replicate/pathway.js");
const { default: transcribe } = await import("../../../pathways/transcribe.js");
const file = "https://example.com/audio.wav";
const output = { detected_language: "en", segments: [{ start: 0, end: 2, text: "Hello world", words: [
  { word: "Hello", start: 0, end: 0.5 }, { word: "world", start: 1, end: 2 },
] }] };
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test("provider-specific inputs preserve language and transcription task", t => {
  t.deepEqual(buildReplicateInput("whisper", file, { language: "Arabic" }), { audio: file, language: "ar", transcription: "plain text", translate: false });
  const x = buildReplicateInput("whisperx", file, { language: "en-US", text: "Names" });
  t.is(x.audio_file, file); t.is(x.language, "en"); t.true(x.align_output); t.false(x.diarization); t.is(x.task, "transcribe");
  t.is(x.initial_prompt, "Names");
  t.false(Object.hasOwn(buildReplicateInput("whisperx", file, { language: "auto" }), "language"));
  t.throws(() => buildReplicateInput("whisper", file, { wordTimestamped: true }), { message: /segment timestamps only/ });
  t.throws(() => buildReplicateInput("whisper", file, { highlightWords: true }));
  t.throws(() => buildReplicateInput("whisperx", "gs://bucket/audio"));
});

test("normalizes real Whisper and WhisperX shapes, keeping absolute offsets and untimed tokens", t => {
  const a = normalizeReplicateOutput(output, 500);
  t.is(a.segments[0].words[1].start, 501); t.is(a.text, "Hello world");
  const b = normalizeReplicateOutput({ transcription: "Hi", segments: [{ text: "Hi", start: 0, end: 1 }] });
  t.is(b.text, "Hi"); t.deepEqual(b.segments[0].words, []);
  t.throws(() => normalizeReplicateOutput({ segments: [{ start: null, end: 1 }] }));
  t.deepEqual(normalizeReplicateChunk({ uri: "gs://private/a", url: file, offset: 0 }, 2), { url: file, offset: 0 });
});

test("text, SRT, VTT, word cues, wrapping and highlighting retain timing", t => {
  const chunks = [normalizeReplicateOutput(output, 500)];
  t.is(formatReplicateTranscript(chunks), "Hello world");
  t.is(formatReplicateTranscript(chunks, { responseFormat: "srt" }), "1\n00:08:20,000 --> 00:08:22,000\nHello world\n");
  t.regex(formatReplicateTranscript(chunks, { wordTimestamped: true }), /^WEBVTT\n\n1\n00:08:20.000 --> 00:08:20.500\nHello/);
  t.regex(formatReplicateTranscript(chunks, { responseFormat: "vtt", maxWordsPerLine: 1, maxLineCount: 1 }), /2\n00:08:21.000 --> 00:08:22.000\nworld/);
  t.regex(formatReplicateTranscript(chunks, { responseFormat: "srt", maxLineWidth: 5 }), /Hello\nworld/);
  t.regex(formatReplicateTranscript(chunks, { responseFormat: "vtt", highlightWords: true }), /<u>Hello<\/u> world/);
  t.is(formatReplicateTranscript([normalizeReplicateOutput({ segments: [] })]), "");
});

test("missing word alignment preserves segment text and refuses invented word timestamps", t => {
  const chunk = normalizeReplicateOutput({ segments: [{ start: 0, end: 2, text: "costs 20", words: [{ word: "costs", start: 0, end: 1 }, { word: "20" }] }] });
  t.is(formatReplicateTranscript([chunk]), "costs 20");
  t.regex(formatReplicateTranscript([chunk], { responseFormat: "srt" }), /costs 20/);
  t.throws(() => formatReplicateTranscript([chunk], { wordTimestamped: true }), { message: /alignment is incomplete/ });
});

test("polls accepted prediction once without trusting provider URLs or leaking credentials", async t => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response(calls.length === 1 ? { id: "p123", status: "starting", urls: { get: "https://evil.example/" } } : { id: "p123", status: "succeeded", output });
  };
  t.deepEqual(await predictTranscription("whisperx", file, {}, { apiKey: "secret", pollMs: 1, fetchImpl }), output);
  t.is(calls.length, 2); t.is(calls[1].url, "https://api.replicate.com/v1/predictions/p123");
  t.is(calls[0].options.headers["Cancel-After"], "600s");
});

test("ambiguous POST is never resubmitted and retains its input", async t => {
  let calls = 0;
  const error = await t.throwsAsync(predictTranscription("whisperx", file, {}, { apiKey: "secret", fetchImpl: async () => { calls++; throw Error("https://private?sig=secret"); } }));
  t.is(calls, 1); t.true(error.inputMayBeInUse); t.false(error.message.includes("secret"));
});

test("cancel before submission makes no provider request", async t => {
  let calls = 0;
  const error = await t.throwsAsync(predictTranscription("whisperx", file, {}, {
    apiKey: "secret", isCanceled: () => true,
    fetchImpl: async () => { calls++; return response({}); },
  }));
  t.is(calls, 0); t.false(error.inputMayBeInUse); t.regex(error.message, /canceled/);
});

test("submission timeout preserves media while an explicit rejection allows cleanup", async t => {
  for (const status of [408, 422, 429]) {
    const error = await t.throwsAsync(predictTranscription("whisperx", file, {}, {
      apiKey: "secret", fetchImpl: async () => response({}, status),
    }));
    t.is(error.inputMayBeInUse, status === 408);
  }
});

test("poll failure cancels accepted job and only permits cleanup after terminal confirmation", async t => {
  for (const confirmed of [false, true]) {
    let calls = 0;
    const fetchImpl = async (url) => {
      calls++;
      if (calls === 1) return response({ id: "p123", status: "processing" });
      if (url.endsWith("/cancel")) return confirmed ? response({ status: "canceled" }) : response({}, 503);
      return response({}, 502);
    };
    const error = await t.throwsAsync(predictTranscription("whisperx", file, {}, { apiKey: "secret", pollMs: 1, fetchImpl }));
    t.is(calls, 3); t.is(error.inputMayBeInUse, !confirmed);
  }
});

test("timeout cancels the prediction; completed provider failures are safe to clean up", async t => {
  let canceled = false;
  const error = await t.throwsAsync(predictTranscription("whisperx", file, {}, {
    apiKey: "secret", timeoutMs: 20, pollMs: 100,
    fetchImpl: async url => {
      if (url.endsWith("/cancel")) { canceled = true; return response({ status: "canceled" }); }
      return response({ id: "p123", status: "processing" });
    },
  }));
  t.true(canceled); t.false(error.inputMayBeInUse); t.regex(error.message, /timed out/);
  const failed = await t.throwsAsync(predictTranscription("whisperx", file, {}, { apiKey: "secret", fetchImpl: async () => response({ id: "p123", status: "failed", error: "secret" }) }));
  t.false(failed.inputMayBeInUse); t.false(failed.message.includes("secret"));
});

test("pathway waits for siblings on failure and does not start a later batch", async t => {
  let finish, started;
  const slow = new Promise(r => { finish = r; });
  const ready = new Promise(r => { started = r; });
  let cleaned = false, calls = 0;
  const pending = executeReplicateTranscription("whisperx", { args: { file }, resolver: {} }, {
    getMediaChunks: async () => Array.from({ length: 5 }, (_, i) => `${file}?part=${i}`),
    predict: async (_provider, url) => {
      calls++;
      if (url.endsWith("0")) throw Error("failed");
      if (url.endsWith("1")) { started(); await slow; }
      return output;
    },
    cleanup: async () => { cleaned = true; },
  });
  await ready; t.false(cleaned); finish(); await t.throwsAsync(pending);
  t.true(cleaned); t.is(calls, 4);
});

test("pathway deduplicates requests, retains explicit offsets and forwards cleanup context", async t => {
  let calls = 0, cleaned;
  const result = await executeReplicateTranscription("whisperx", { args: { file, responseFormat: "srt", contextId: "ctx" }, resolver: { requestId: "req" } }, {
    getMediaChunks: async () => [{ uri: file, offset: 0 }, { uri: file, offset: 7 }],
    predict: async () => { calls++; return output; },
    cleanup: async (...args) => { cleaned = args; }, publish: () => {},
  });
  t.is(calls, 1); t.deepEqual(cleaned, ["req", "ctx"]); t.regex(result, /00:00:07,000 --> 00:00:09,000/);
});

test("pathway preserves media after unconfirmed failure", async t => {
  let cleaned = false;
  await t.throwsAsync(executeReplicateTranscription("whisperx", { args: { file }, resolver: {} }, {
    getMediaChunks: async () => [file], predict: async () => { throw Object.assign(Error("unknown"), { inputMayBeInUse: true }); }, cleanup: async () => { cleaned = true; },
  }));
  t.false(cleaned);
});

test.serial("default route still calls the existing OpenAI prompts and invalid configuration fails", async t => {
  const old = process.env.TRANSCRIBE_PROVIDER;
  t.teardown(() => old === undefined ? delete process.env.TRANSCRIBE_PROVIDER : process.env.TRANSCRIBE_PROVIDER = old);
  delete process.env.TRANSCRIBE_PROVIDER;
  const args = { file };
  t.is(await transcribe.executePathway({ args, runAllPrompts: actual => { t.is(actual, args); return "openai"; } }), "openai");
  process.env.TRANSCRIBE_PROVIDER = "typo";
  t.throws(() => transcribe.executePathway({ args }), { message: /Unknown TRANSCRIBE_PROVIDER/ });
});

test("benchmark WER uses reference speech rather than another provider as truth", t => {
  t.is(wordErrorRate("Hello world", "hello world!"), 0);
  t.is(wordErrorRate("one two three", "one three"), 1 / 3);
  t.is(wordErrorRate("العَرَبِيَّة", "العربية"), 0);
});

test("benchmark SRT parsing counts timed cues and extracts subtitle markup as text", t => {
  const srt = "1\r\n00:00:00,000 --> 00:00:01,000\r\n<u><b>Hello</b></u> &amp; world<!-- hidden --!>\r\n\r\n2\r\n00:00:01,000 --> 00:00:02,000\r\nleft --> right العربية\r\n";
  t.deepEqual(summarizeSrt(srt), { text: "Hello & world left --> right العربية", cues: 2 });
  t.deepEqual(summarizeSrt("no timestamp --> no cue"), { text: "", cues: 0 });
});

test("configured model versions match the pinned providers used by explicit pathways", async t => {
  const config = JSON.parse(fs.readFileSync(new URL("../../../config/default.example.json", import.meta.url)));
  for (const [name, { version }] of Object.entries(REPLICATE_TRANSCRIPTION_MODELS)) {
    t.is(config.models[`replicate-${name}`].params.version, version);
    const { default: pathway } = await import(`../../../pathways/transcribe_replicate_${name}.js`);
    t.is(pathway.model, `replicate-${name}`);
  }
});
