import test from "ava";
import { alignWords } from "../../../pathways/shared/transcribe_xai/alignment.js";
import { buildSegments } from "../../../pathways/shared/transcribe_xai/segments.js";
import {
  callXaiStt,
  getXaiChunks,
  mapChunksWithConcurrency,
  mergeOverlappedChunks,
  redactTextForLog,
} from "../../../pathways/shared/transcribe_xai/shared.js";

const word = (text, start, end) => ({ text, start, end });
const countWords = (text) => text.trim().split(/\s+/).filter(Boolean).length;
const expectMaxWordsPerLine = (t, segments, maxWordsPerLine) => {
  for (const segment of segments) {
    t.true(
      countWords(segment.text) <= maxWordsPerLine,
      `${segment.text} should have at most ${maxWordsPerLine} words`,
    );
  }
};
const expectMaxLineWidth = (t, segments, maxLineWidth) => {
  for (const segment of segments) {
    t.true(
      segment.text.length <= maxLineWidth || countWords(segment.text) === 1,
      `${segment.text} should fit within ${maxLineWidth} chars unless it is one overlong word`,
    );
  }
};

test("buildSegments handles a single word longer than maxLineWidth", (t) => {
  const segments = buildSegments(
    [word("supercalifragilisticexpialidocious", 0, 2)],
    { maxLineWidth: 25 },
  );

  t.deepEqual(segments, [
    {
      start: 0,
      end: 2,
      text: "supercalifragilisticexpialidocious",
    },
  ]);
});

test("buildSegments breaks below minWords when maxWordsPerLine requires it", (t) => {
  const segments = buildSegments(
    [word("one", 0, 1.1), word("two", 1.2, 2.3), word("three", 2.4, 3.5)],
    { maxWordsPerLine: 1 },
  );

  t.deepEqual(
    segments.map((segment) => segment.text),
    ["one", "two", "three"],
  );
});

test("buildSegments preserves maxWordsPerLine when short cues would otherwise merge", (t) => {
  const segments = buildSegments(
    ["one", "two", "three", "four", "five", "six"].map((text, i) =>
      word(text, i * 0.2, i * 0.2 + 0.1),
    ),
    { maxWordsPerLine: 2 },
  );

  t.deepEqual(
    segments.map((segment) => segment.text),
    ["one two", "three four", "five six"],
  );
});

test("buildSegments emits one cue per word for word-level timestamps", (t) => {
  const words = ["one", "two", "three"].map((text, i) =>
    word(text, i, i + 0.5),
  );
  const segments = buildSegments(words, { wordTimestamped: true });

  t.deepEqual(
    segments.map((segment) => segment.text),
    ["one", "two", "three"],
  );
});

test("buildSegments preserves UI words-per-line limits", (t) => {
  const words = ["one", "two", "three", "four", "five", "six"].map((text, i) =>
    word(text, i * 0.2, i * 0.2 + 0.1),
  );

  for (const maxWordsPerLine of [1, 2, 3]) {
    expectMaxWordsPerLine(
      t,
      buildSegments(words, { maxWordsPerLine }),
      maxWordsPerLine,
    );
  }
});

test("buildSegments treats maxWordsPerLine as a hard UI contract", (t) => {
  const words = [
    "برميل",
    "على",
    "بناية",
    "تكون",
    "كلها",
    "عائلات",
    "يعني",
  ].map((text, i) => word(text, i * 0.4, i * 0.4 + 0.3));

  const segments = buildSegments(
    words,
    { wordTimestamped: true, maxWordsPerLine: 2 },
    { trustGaps: false },
  );

  t.deepEqual(
    segments.map((segment) => segment.text),
    ["برميل على", "بناية تكون", "كلها عائلات", "يعني"],
  );
  expectMaxWordsPerLine(t, segments, 2);
});

test("buildSegments keeps words-per-line timestamps monotonic", (t) => {
  const segments = buildSegments(
    [
      word("one", 0, 1),
      word("two", 0.8, 0.9),
      word("three", 0.7, 0.75),
      word("four", 1.2, 1.4),
    ],
    { maxWordsPerLine: 1 },
  );

  for (let i = 1; i < segments.length; i++) {
    t.true(segments[i].start >= segments[i - 1].end);
    t.true(segments[i].end > segments[i].start);
  }
});

test("buildSegments preserves UI line-width limits when short cues would otherwise merge", (t) => {
  const words = [
    "alpha",
    "bravo",
    "charlie",
    "delta",
    "echo",
    "foxtrot",
    "golf",
    "hotel",
  ].map((text, i) => word(text, i * 0.2, i * 0.2 + 0.1));

  for (const maxLineWidth of [25, 35]) {
    expectMaxLineWidth(t, buildSegments(words, { maxLineWidth }), maxLineWidth);
  }
});

test("buildSegments keeps plain/default segmentation grouped", (t) => {
  const segments = buildSegments(
    ["one", "two", "three", "four", "five", "six"].map((text, i) =>
      word(text, i, i + 0.5),
    ),
  );

  t.deepEqual(
    segments.map((segment) => segment.text),
    ["one two three four five six"],
  );
});

test("alignWords matches repeated phrases in timestamp order", (t) => {
  const aligned = alignWords(
    ["hello", "world", "hello", "world"],
    [
      word("hello", 0, 0.4),
      word("world", 0.5, 0.9),
      word("hello", 10, 10.4),
      word("world", 10.5, 10.9),
    ],
    12,
  );

  t.deepEqual(
    aligned.map((w) => [w.text, w.start, w.type]),
    [
      ["hello", 0, "anchor"],
      ["world", 0.5, "anchor"],
      ["hello", 10, "anchor"],
      ["world", 10.5, "anchor"],
    ],
  );
});

test("alignWords normalizes Arabic variants before anchoring", (t) => {
  const aligned = alignWords(
    ["أنا", "في", "مدرسة"],
    [word("انا", 0, 0.3), word("في", 0.4, 0.6), word("مدرسه", 0.7, 1.1)],
    2,
  );

  t.true(aligned.every((w) => w.type === "anchor"));
});

test("alignWords falls back to even interpolation without timestamp anchors", (t) => {
  const aligned = alignWords(["alpha", "beta"], [], 10);

  t.deepEqual(aligned, [
    { text: "alpha", start: 0, end: 5, type: "interp" },
    { text: "beta", start: 5, end: 10, type: "interp" },
  ]);
});

test("alignWords filters a severe out-of-order timestamp anchor", (t) => {
  const aligned = alignWords(
    ["one", "two", "three"],
    [word("one", 0, 0.5), word("two", 50, 50.5), word("three", 5, 5.5)],
    60,
  );

  t.is(aligned[0].type, "anchor");
  t.is(aligned[1].type, "interp");
  t.true(aligned[1].start >= aligned[0].end);
  t.true(aligned[1].end <= aligned[2].start);
  t.true(aligned[2].end <= 60);
});

test("getXaiChunks normalizes media-helper chunks for xAI and Gemini", async (t) => {
  const chunks = await getXaiChunks(
    "https://origin.example/audio.wav",
    "request-1",
    "context-1",
    async (file, requestId, contextId) => {
      t.is(file, "https://origin.example/audio.wav");
      t.is(requestId, "request-1");
      t.is(contextId, "context-1");
      return [
        {
          uri: "https://media.example/chunk-1.mp3?sig=secret",
          gcs: "gs://bucket/chunk-1.mp3",
          offset: 500,
        },
      ];
    },
  );

  t.deepEqual(chunks, [
    {
      url: "https://media.example/chunk-1.mp3?sig=secret",
      geminiFile: "gs://bucket/chunk-1.mp3",
      offset: 500,
    },
  ]);
});

test("getXaiChunks forwards optional media-helper overlap", async (t) => {
  await getXaiChunks(
    "https://origin.example/audio.wav",
    "request-1",
    "context-1",
    async (file, requestId, contextId, options) => {
      t.is(file, "https://origin.example/audio.wav");
      t.is(requestId, "request-1");
      t.is(contextId, "context-1");
      t.deepEqual(options, { chunkOverlapSeconds: 2 });
      return [
        {
          uri: "https://media.example/chunk-1.mp3",
          offset: 0,
        },
        {
          uri: "https://media.example/chunk-2.mp3",
          offset: 498,
        },
      ];
    },
    { chunkOverlapSeconds: 2 },
  );
});

test("mergeOverlappedChunks keeps each chunk's non-overlapped core", (t) => {
  const chunks = [
    {
      start: 0,
      end: 5,
      words: [
        word("alpha", 0, 0.4),
        word("bravo", 4.1, 4.5),
        word("charlie", 4.6, 4.9),
      ],
    },
    {
      start: 4,
      end: 9,
      words: [
        word("bravo", 4.1, 4.5),
        word("charlie", 4.6, 4.9),
        word("delta", 5.1, 5.5),
      ],
    },
  ];

  t.deepEqual(
    mergeOverlappedChunks(chunks).map((w) => w.text),
    ["alpha", "bravo", "charlie", "delta"],
  );
});

test("getXaiChunks refuses original URL fallback for normal media", async (t) => {
  await t.throwsAsync(
    () =>
      getXaiChunks(
        "https://origin.example/audio.wav",
        "request-1",
        null,
        async () => ["https://origin.example/audio.wav"],
      ),
    {
      message:
        "xAI transcription requires media-helper chunk URLs; refusing to use the original media URL as a fallback.",
    },
  );
});

test("getXaiChunks rejects chunk objects without xAI-fetchable URLs", async (t) => {
  await t.throwsAsync(
    () =>
      getXaiChunks(
        "https://origin.example/audio.wav",
        "request-1",
        null,
        async () => [{ offset: 0 }, { offset: 120 }],
      ),
    {
      message: "Media helper returned no fetchable chunk URLs for xAI transcription",
    },
  );
});

test.serial("mapChunksWithConcurrency caps an excessive env setting", async (t) => {
  const original = process.env.XAI_TRANSCRIBE_CHUNK_CONCURRENCY;
  process.env.XAI_TRANSCRIBE_CHUNK_CONCURRENCY = "1000";
  let active = 0;
  let maxActive = 0;

  try {
    const result = await mapChunksWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      async (chunk) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return chunk * 2;
      },
    );

    t.true(maxActive <= 8);
    t.deepEqual(
      result,
      Array.from({ length: 20 }, (_, i) => i * 2),
    );
  } finally {
    if (original === undefined)
      delete process.env.XAI_TRANSCRIBE_CHUNK_CONCURRENCY;
    else process.env.XAI_TRANSCRIBE_CHUNK_CONCURRENCY = original;
  }
});

test("redactTextForLog removes signed URLs and common credentials", (t) => {
  const basicCredentialFixture = ["dXNl", "cjpw", "YXNz"].join("");
  const awsKeyFixture = ["AKIA", "1234567890ABCDEF"].join("");
  const jwtFixture = [
    "eyJhbGciOiJIUzI1NiJ9",
    "eyJzdWIiOiIxIn0",
    "signature",
  ].join(".");
  const redacted = redactTextForLog(
    [
      "https://storage.example/a.wav?sig=secret&token=abc",
      "Bearer abc.def",
      `Basic ${basicCredentialFixture}`,
      awsKeyFixture,
      "password=hunter2",
      jwtFixture,
    ].join(" "),
  );

  t.true(redacted.includes("https://storage.example/a.wav?***REDACTED***"));
  t.true(redacted.includes("Bearer ***REDACTED***"));
  t.true(redacted.includes("Basic ***REDACTED***"));
  t.true(redacted.includes("***REDACTED_AWS_KEY***"));
  t.true(redacted.includes("password=***REDACTED***"));
  t.true(redacted.includes("***REDACTED_JWT***"));
  t.false(redacted.includes("hunter2"));
});

test.serial("callXaiStt fails fast when XAI_API_KEY is missing", async (t) => {
  const originalKey = process.env.XAI_API_KEY;
  delete process.env.XAI_API_KEY;

  try {
    await t.throwsAsync(() => callXaiStt("https://media.example/chunk.mp3"), {
      message: "XAI_API_KEY is not set",
    });
  } finally {
    if (originalKey !== undefined) process.env.XAI_API_KEY = originalKey;
  }
});

test.serial("callXaiStt sends an authorized request and filters invalid words", async (t) => {
  const originalFetch = global.fetch;
  const originalKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = "test-key";
  global.fetch = async (url, options) => {
    t.is(url, "https://api.x.ai/v1/stt");
    t.is(options.method, "POST");
    t.is(options.headers.Authorization, "Bearer test-key");
    t.is(options.body.get("url"), "https://media.example/chunk.mp3");
    t.is(options.body.get("language"), "en");
    return {
      ok: true,
      json: async () => ({
        text: "hello",
        duration: 1.2,
        words: [
          { text: " hello ", start: 0, end: 0.5 },
          { text: "bad", start: 1, end: 0 },
        ],
      }),
    };
  };

  try {
    const result = await callXaiStt("https://media.example/chunk.mp3", "en");
    t.deepEqual(result, {
      text: "hello",
      duration: 1.2,
      words: [{ text: "hello", start: 0, end: 0.5 }],
    });
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = originalKey;
  }
});

test.serial("callXaiStt allows an endpoint override for tests and staging", async (t) => {
  const originalFetch = global.fetch;
  const originalKey = process.env.XAI_API_KEY;
  const originalUrl = process.env.XAI_STT_URL;
  process.env.XAI_API_KEY = "test-key";
  process.env.XAI_STT_URL = "https://xai.test.local/stt";
  global.fetch = async (url) => {
    t.is(url, "https://xai.test.local/stt");
    return {
      ok: true,
      json: async () => ({ text: "ok", duration: 1, words: [] }),
    };
  };

  try {
    const result = await callXaiStt("https://media.example/chunk.mp3", "en");
    t.is(result.text, "ok");
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = originalKey;
    if (originalUrl === undefined) delete process.env.XAI_STT_URL;
    else process.env.XAI_STT_URL = originalUrl;
  }
});

test.serial("callXaiStt reports invalid JSON responses clearly", async (t) => {
  const originalFetch = global.fetch;
  const originalKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = "test-key";
  global.fetch = async () => ({
    ok: true,
    json: async () => {
      throw new SyntaxError("Unexpected token <");
    },
  });

  try {
    await t.throwsAsync(
      () => callXaiStt("https://media.example/chunk.mp3", "en"),
      { message: /xAI STT returned invalid JSON/ },
    );
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = originalKey;
  }
});
