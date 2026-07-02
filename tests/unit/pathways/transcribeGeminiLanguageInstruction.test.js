import test from "ava";
import { readFileSync } from "node:fs";

process.env.OPENAI_API_KEY ||= "test-openai-key";

const {
  default: transcribeGemini,
  getTranscriptionFallbackFile,
  isGeminiSafetyBlockedResult,
} = await import("../../../pathways/transcribe_gemini.js");
const {
  default: transcribeXaiGemini,
  buildXaiFallbackWords,
  getGeminiChunkWords,
  runWithChildResolver,
} = await import("../../../pathways/transcribe_xai_gemini.js");

async function captureSystemPrompt(language) {
  let capturedMessages;

  await transcribeGemini.executePathway({
    args: {
      file: "gs://test-bucket/hindi.wav",
      language,
      responseFormat: "text",
      wordTimestamped: false,
    },
    runAllPrompts: async ({ messages }) => {
      capturedMessages = messages;
      return "नमस्ते दुनिया";
    },
    resolver: {
      requestId: `transcribe-gemini-language-${language}`,
    },
  });

  return capturedMessages?.[0]?.content || "";
}

for (const language of ["hi", "Hindi"]) {
  test(`Gemini transcription asks for Devanagari script for ${language}`, async (t) => {
    const systemPrompt = await captureSystemPrompt(language);

    t.true(systemPrompt.includes("The spoken language is Hindi."));
    t.true(systemPrompt.includes("Hindi Devanagari script"));
    t.true(systemPrompt.includes("Do not use Latin"));
  });
}

test("Gemini transcription disables configurable safety blocking", (t) => {
  t.deepEqual(
    transcribeGemini.geminiSafetySettings.map(({ category, threshold }) => ({
      category,
      threshold,
    })),
    [
      {
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: "BLOCK_NONE",
      },
      {
        category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        threshold: "BLOCK_NONE",
      },
      {
        category: "HARM_CATEGORY_HARASSMENT",
        threshold: "BLOCK_NONE",
      },
      {
        category: "HARM_CATEGORY_HATE_SPEECH",
        threshold: "BLOCK_NONE",
      },
    ],
  );
});

test("xAI + Gemini transcription inherits disabled Gemini safety blocking", (t) => {
  t.deepEqual(
    transcribeXaiGemini.geminiSafetySettings.map(({ category, threshold }) => ({
      category,
      threshold,
    })),
    transcribeGemini.geminiSafetySettings.map(({ category, threshold }) => ({
      category,
      threshold,
    })),
  );
});

test("Gemini transcription recognizes structured safety block results", (t) => {
  t.true(isGeminiSafetyBlockedResult({ finishReason: "SAFETY" }));
  t.true(isGeminiSafetyBlockedResult({ finish_reason: "content_filter" }));
  t.true(
    isGeminiSafetyBlockedResult({
      promptFeedback: { blockReason: "SAFETY" },
    }),
  );
  t.false(isGeminiSafetyBlockedResult({ finishReason: "STOP" }));
});

test("Gemini transcription can disable the non-Gemini safety fallback", async (t) => {
  const error = await t.throwsAsync(
    transcribeGemini.executePathway({
      args: {
        file: "gs://test-bucket/blocked.wav",
        responseFormat: "text",
        allowTranscriptionFallback: false,
      },
      runAllPrompts: async () => ({ finishReason: "SAFETY" }),
      resolver: {
        requestId: "transcribe-gemini-no-fallback",
      },
    }),
  );
  t.is(error.message, "Gemini transcription blocked by safety ratings");
});

test("xAI + Gemini opts out of Gemini safety fallback to transcribe", (t) => {
  const source = readFileSync(
    new URL("../../../pathways/transcribe_xai_gemini.js", import.meta.url),
    "utf8",
  );
  t.true(source.includes("allowTranscriptionFallback: false"));
});

test("xAI + Gemini can preserve a chunk when Gemini returns no text", (t) => {
  const xWords = [
    { text: "opening", start: 0.56, end: 0.92 },
    { text: "move", start: 1.3, end: 1.65 },
  ];

  t.deepEqual(
    buildXaiFallbackWords(xWords),
    [
      {
        text: "opening",
        start: 0.56,
        end: 0.92,
        gapAfter: 0.38,
        type: "anchor",
        source: "xai",
      },
      {
        text: "move",
        start: 1.3,
        end: 1.65,
        gapAfter: 0,
        type: "anchor",
        source: "xai",
      },
    ],
  );
});

test("xAI + Gemini retries empty Gemini chunks before xAI text fallback", async (t) => {
  let retryCount = 0;

  const result = await getGeminiChunkWords({
    gTextResultPromise: Promise.resolve({ status: "fulfilled", value: "" }),
    retryGeminiTranscription: async () => {
      retryCount++;
      return "";
    },
    chunkLabel: "chunk 2/3",
  });

  t.is(retryCount, 1);
  t.deepEqual(result, { words: [], issue: "empty Gemini output" });
});

test("xAI + Gemini keeps Gemini text when chunk retry succeeds", async (t) => {
  const result = await getGeminiChunkWords({
    gTextResultPromise: Promise.resolve({ status: "fulfilled", value: "" }),
    retryGeminiTranscription: async () => "gemini retry text",
    chunkLabel: "chunk 2/3",
  });

  t.deepEqual(result, {
    words: ["gemini", "retry", "text"],
    issue: "empty Gemini output",
  });
});

test("xAI + Gemini retries rejected Gemini chunks when xAI has timing", async (t) => {
  let retryCount = 0;

  const result = await getGeminiChunkWords({
    gTextResultPromise: Promise.resolve({
      status: "rejected",
      reason: new Error("blocked"),
    }),
    retryGeminiTranscription: async () => {
      retryCount++;
      return "recovered text";
    },
    chunkLabel: "chunk 2/3",
  });

  t.is(retryCount, 1);
  t.deepEqual(result, {
    words: ["recovered", "text"],
    issue: "Gemini failure",
  });
});

test("xAI + Gemini retries Gemini chunks even when xAI has no words", async (t) => {
  let retryCount = 0;

  const result = await getGeminiChunkWords({
    gTextResultPromise: Promise.resolve({
      status: "rejected",
      reason: new Error("blocked"),
    }),
    retryGeminiTranscription: async () => {
      retryCount++;
      return "gemini recovered text";
    },
    chunkLabel: "chunk 2/3",
  });

  t.is(retryCount, 1);
  t.deepEqual(result, {
    words: ["gemini", "recovered", "text"],
    issue: "Gemini failure",
  });
});

test("xAI + Gemini keeps handled child errors off the parent resolver", async (t) => {
  class ChildResolver {
    constructor() {
      this.requestId = "child-request";
      this.errors = [];
    }

    async promptAndParse() {
      this.errors.push("Response was not completed");
      return "";
    }
  }
  const parentResolver = {
    config: {},
    endpoints: {},
    requestId: "parent-request",
    rootRequestId: "root-request",
    errors: ["existing error"],
    constructor: ChildResolver,
  };

  const error = await t.throwsAsync(
    runWithChildResolver({
      parentResolver,
      pathway: transcribeXaiGemini,
      args: {},
      run: ({ runAllPrompts, resolver }) => {
        t.is(resolver.requestId, "child-request");
        t.is(resolver.rootRequestId, "root-request");
        return runAllPrompts({});
      },
    }),
  );

  t.is(error.message, "Response was not completed");
  t.deepEqual(parentResolver.errors, ["existing error"]);
});

test("xAI + Gemini scopes concurrent child chunk errors", async (t) => {
  let releaseFirst;
  let childCount = 0;
  class ChildResolver {
    constructor() {
      this.requestId = `child-request-${++childCount}`;
      this.errors = [];
    }

    async promptAndParse({ label }) {
      if (label === "first") {
        await new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
      this.errors.push(`${label} failed`);
      return label === "second" ? "second text" : "";
    }
  }
  const parentResolver = {
    config: {},
    endpoints: {},
    requestId: "parent-request",
    errors: [],
    constructor: ChildResolver,
  };

  const first = runWithChildResolver({
    parentResolver,
    pathway: transcribeXaiGemini,
    args: {},
    run: ({ runAllPrompts }) => runAllPrompts({ label: "first" }),
  });
  const second = runWithChildResolver({
    parentResolver,
    pathway: transcribeXaiGemini,
    args: {},
    run: ({ runAllPrompts }) => runAllPrompts({ label: "second" }),
  });

  t.is(await second, "second text");
  releaseFirst();

  const error = await t.throwsAsync(first);
  t.is(error.message, "first failed");
  t.is(childCount, 2);
  t.deepEqual(parentResolver.errors, []);
});

test("xAI + Gemini treats empty chunk output with resolver errors as failed Gemini", async (t) => {
  class ChildResolver {
    constructor() {
      this.requestId = "child-request";
      this.errors = [];
    }

    async promptAndParse() {
      this.errors.push("Response was not completed");
      return "";
    }
  }
  const parentResolver = {
    config: {},
    endpoints: {},
    requestId: "parent-request",
    errors: [],
    constructor: ChildResolver,
  };
  const gTextResultPromise = runWithChildResolver({
    parentResolver,
    pathway: transcribeXaiGemini,
    args: {},
    run: ({ runAllPrompts }) => runAllPrompts({}),
  }).then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );

  const result = await getGeminiChunkWords({
    gTextResultPromise,
    retryGeminiTranscription: async () => "retry text",
    chunkLabel: "chunk 2/3",
  });

  t.deepEqual(result, {
    words: ["retry", "text"],
    issue: "Gemini failure",
  });
  t.deepEqual(parentResolver.errors, []);
});

test("Gemini transcription fallback prefers fetchable chunk URLs", (t) => {
  t.is(
    getTranscriptionFallbackFile({
      gcs: "gs://bucket/chunk.wav",
      uri: "https://storage.example/chunk.wav",
    }),
    "https://storage.example/chunk.wav",
  );
  t.is(
    getTranscriptionFallbackFile({
      gcs: "gs://bucket/chunk.wav",
      url: "https://storage.example/url.wav",
    }),
    "https://storage.example/url.wav",
  );
});
