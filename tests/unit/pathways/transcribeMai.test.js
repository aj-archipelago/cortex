import test from "ava";

process.env.OPENAI_API_KEY ||= "test-openai-key";

const {
  buildMaiDefinition,
  extractMaiText,
  formatMaiResult,
  MAI_TRANSCRIBE_15_MODEL,
  normalizeMaiChunk,
  phrasesToSubtitles,
} = await import("../../../pathways/transcribe_mai_15.js");

test("builds MAI-Transcribe-1.5 enhanced-mode definition", (t) => {
  t.deepEqual(JSON.parse(buildMaiDefinition("ar")), {
    locales: ["ar"],
    enhancedMode: {
      enabled: true,
      model: MAI_TRANSCRIBE_15_MODEL,
    },
  });
});

test("normalizes common language labels in MAI definition", (t) => {
  t.false(Object.hasOwn(JSON.parse(buildMaiDefinition("")), "locales"));
  t.false(Object.hasOwn(JSON.parse(buildMaiDefinition("auto")), "locales"));
  t.deepEqual(JSON.parse(buildMaiDefinition("English")).locales, ["en"]);
  t.deepEqual(JSON.parse(buildMaiDefinition("en-US")).locales, ["en"]);
  t.deepEqual(JSON.parse(buildMaiDefinition("Hindi")).locales, ["hi"]);
  t.deepEqual(JSON.parse(buildMaiDefinition("Urdu")).locales, ["ur"]);
  t.deepEqual(JSON.parse(buildMaiDefinition("punjabi")).locales, ["pa"]);
});

test("extracts text from combined phrases before raw phrases", (t) => {
  t.is(
    extractMaiText({
      combinedPhrases: [{ text: "combined text" }],
      phrases: [{ text: "raw phrase" }],
    }),
    "combined text",
  );

  t.is(
    extractMaiText({
      phrases: [{ text: "first" }, { text: "second" }],
    }),
    "first second",
  );
});

test("normalizes media chunks with fetchable URL preference and stable offsets", (t) => {
  t.deepEqual(
    normalizeMaiChunk(
      {
        uri: "gs://bucket/internal.wav",
        url: "https://signed.example/chunk.wav",
        offset: 0,
      },
      2,
    ),
    {
      url: "https://signed.example/chunk.wav",
      offsetSeconds: 0,
    },
  );

  t.deepEqual(
    normalizeMaiChunk({ signedUrl: "https://signed.example/2.wav" }, 3),
    {
      url: "https://signed.example/2.wav",
      offsetSeconds: 1500,
    },
  );
});

test("formats MAI phrases as SRT and VTT", (t) => {
  const phrases = [
    {
      offsetMilliseconds: 1500,
      durationMilliseconds: 2250,
      text: "hello world",
    },
  ];

  t.is(
    phrasesToSubtitles(phrases, "srt"),
    "1\n00:00:01,500 --> 00:00:03,750\nhello world\n",
  );
  t.is(
    phrasesToSubtitles(phrases, "vtt"),
    "WEBVTT\n\n1\n00:00:01.500 --> 00:00:03.750\nhello world\n",
  );
});

test("returns phrase-level VTT when wordTimestamped is requested", (t) => {
  t.true(
    formatMaiResult(
      {
        text: "plain text",
        phrases: [
          {
            offsetMilliseconds: 0,
            durationMilliseconds: 1000,
            text: "plain",
          },
        ],
      },
      "text",
      true,
    ).startsWith("WEBVTT"),
  );
});
