import test from "ava";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildGeminiTranscriptionRequest,
  parseGeminiTranscription,
  buildScribeInput,
  transcribeGeminiFile,
  transcribeScribeUrl,
} from "../../../pathways/shared/transcribe_media/providers.js";
import {
  formatTranscript,
  normalizeMediaChunk,
} from "../../../pathways/shared/transcribe_media/pathway.js";

const result = {
  status: "completed",
  steps: [
    { type: "user_input", content: [{ type: "text", text: "Ignore" }] },
    {
      type: "model_output",
      content: [
        {
          type: "text",
          text: "مرحبا world",
          annotations: [
            {
              type: "word_info",
              text: "مرحبا",
              start_offset: "0.100s",
              end_offset: "0.450s",
              speaker: "spk_1",
            },
            {
              type: "word_info",
              text: "world",
              start_offset: "0.500s",
              end_offset: "0.850s",
              speaker: "spk_2",
            },
          ],
        },
      ],
    },
  ],
};
test("Gemini dedicated ASR uses verbatim word annotations and enforces vocabulary incompatibilities", (t) => {
  const request = buildGeminiTranscriptionRequest(
    "https://example.com/a",
    "audio/mpeg",
    { responseFormat: "vtt", language: "ar", diarize: true },
  );
  t.is(request.model, "gemini-3.5-transcribe");
  t.deepEqual(request.generation_config.transcription_config, {
    language_codes: ["ar"],
    mode: {
      type: "verbatim",
      timestamp_granularities: ["word"],
      diarization_mode: "speaker",
    },
  });
  t.throws(() =>
    buildGeminiTranscriptionRequest("uri", "audio/mpeg", {
      responseFormat: "vtt",
      vocabulary: ["Concierge"],
    }),
  );
  t.deepEqual(
    buildGeminiTranscriptionRequest("uri", "audio/mpeg", {
      vocabulary: ["Concierge"],
    }).generation_config.transcription_config.custom_vocabulary,
    ["Concierge"],
  );
  const parsed = parseGeminiTranscription(result);
  t.is(parsed.text, "مرحبا world");
  t.is(parsed.words[0].start, 0.1);
  t.is(parsed.words[1].speaker, "spk_2");
});
test("chunked ASR keeps absolute word timing for VTT/SRT and scopes speaker identities", (t) => {
  const parsed = parseGeminiTranscription(result);
  const parts = [
    { ...parsed, offset: 0, index: 0 },
    { ...parsed, offset: 500, index: 1 },
  ];
  const vtt = formatTranscript(parts, {
    responseFormat: "vtt",
    wordTimestamped: true,
  });
  t.regex(vtt, /(?:00:)?08:20.100 --> (?:00:)?08:20.450/);
  t.regex(
    formatTranscript(parts, { responseFormat: "srt", wordTimestamped: true }),
    /00:08:20,100 --> 00:08:20,450/,
  );
  const json = JSON.parse(formatTranscript(parts, { responseFormat: "json" }));
  t.is(json.words[0].speaker, "1:spk_1");
  t.is(json.words[2].speaker, "2:spk_1");
  t.throws(() =>
    formatTranscript([{ text: "Lost timestamps", words: [], offset: 0 }], {
      responseFormat: "vtt",
    }),
  );
  t.throws(() =>
    formatTranscript(
      [
        {
          text: "Bad timestamps",
          words: [{ text: "Bad", start: NaN, end: 1 }],
          offset: 0,
        },
      ],
      { responseFormat: "vtt" },
    ),
  );
  t.throws(() =>
    formatTranscript(
      [
        {
          text: "Missing",
          words: [{ text: "Missing", start: null, end: null }],
          offset: 500,
        },
      ],
      { responseFormat: "vtt" },
    ),
  );
  t.is(
    normalizeMediaChunk({ url: "https://example.com/a.mp3", offset: 123 }, 1)
      .offset,
    123,
  );
  t.throws(() => normalizeMediaChunk("gs://bucket/a", 0));
});
test("Scribe input enables word timing via Replicate without a new vendor key", (t) => {
  t.deepEqual(
    buildScribeInput("https://example.com/a", {
      language: "ar",
      diarize: true,
      vocabulary: ["الجزيرة"],
    }),
    {
      audio: "https://example.com/a",
      language_code: "ar",
      diarize: true,
      timestamps_granularity: "word",
      tag_audio_events: false,
      keyterms: "الجزيرة",
      no_verbatim: false,
    },
  );
  t.throws(() => buildScribeInput("url", { vocabulary: ["a,b"] }));
});
test.serial(
  "Gemini uploads audio, authenticates only to Google, and deletes temporary files after success or failure",
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "asr-contract-"));
    const file = path.join(dir, "chunk.mp3");
    await fs.writeFile(file, "fake-audio");
    const originalFetch = global.fetch;
    try {
      for (const fail of [false, true]) {
        const calls = [];
        global.fetch = async (url, options) => {
          calls.push({ url, options });
          t.is(new URL(url).hostname, "generativelanguage.googleapis.com");
          t.is(options.headers["x-goog-api-key"], "test-key");
          if (url.endsWith("/upload/v1beta/files"))
            return new Response("", {
              headers: {
                "x-goog-upload-url":
                  "https://generativelanguage.googleapis.com/upload-session",
              },
            });
          if (url.endsWith("/upload-session"))
            return Response.json({
              file: {
                name: "files/test-123",
                state: "ACTIVE",
                uri: "https://generativelanguage.googleapis.com/v1beta/files/test-123",
              },
            });
          if (options.method === "DELETE")
            return new Response("", { status: 200 });
          return fail
            ? new Response("upstream details not exposed", { status: 429 })
            : Response.json(result);
        };
        const run = () =>
          transcribeGeminiFile(
            file,
            "audio/mpeg",
            { responseFormat: "vtt" },
            "test-key",
            AbortSignal.timeout(5000),
          );
        if (fail) await t.throwsAsync(run, { message: /429/ });
        else t.is((await run()).words.length, 2);
        t.is(calls.at(-1).options.method, "DELETE");
        t.is(JSON.parse(calls[2].options.body).model, "gemini-3.5-transcribe");
      }
    } finally {
      global.fetch = originalFetch;
      await fs.rm(dir, { recursive: true });
    }
  },
);
test.serial(
  "Scribe uses only the Replicate endpoint and ignores non-word events",
  async (t) => {
    const originalFetch = global.fetch;
    try {
      global.fetch = async (url, options) => {
        t.is(
          url,
          "https://api.replicate.com/v1/models/elevenlabs/scribe-v2/predictions",
        );
        t.is(options.headers.Authorization, "Bearer test-key");
        return Response.json({
          status: "succeeded",
          output: {
            text: "Hello",
            words: [
              { text: "Hello", type: "word", start: 0, end: 1 },
              { text: " ", type: "spacing" },
            ],
          },
        });
      };
      t.is(
        (
          await transcribeScribeUrl(
            "https://example.com/a.mp3",
            {},
            "test-key",
            AbortSignal.timeout(5000),
          )
        ).words.length,
        1,
      );
    } finally {
      global.fetch = originalFetch;
    }
  },
);
