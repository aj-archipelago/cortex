import test from "ava";
import GeminiMusicPlugin from "../../../server/plugins/geminiMusicPlugin.js";

function createPlugin() {
  return new GeminiMusicPlugin(
    {
      name: "music_lyria",
      prompt: ["{{text}}"],
      inputParameters: {
        text: "",
      },
    },
    {
      name: "google-lyria-3-music",
      type: "GEMINI-MUSIC",
      lyriaModel: "lyria-3-clip-preview",
    },
  );
}

test("GeminiMusicPlugin requests Agent Platform interaction input", (t) => {
  const plugin = createPlugin();

  const request = plugin.getRequestParameters(
    "brief: focused documentary theme",
    {},
    { prompt: "{{text}}" },
  );

  t.deepEqual(request, {
    model: "lyria-3-clip-preview",
    input: [
      {
        type: "text",
        text: "brief: focused documentary theme",
      },
    ],
  });
});

test("GeminiMusicPlugin request summaries do not include prompt text", (t) => {
  const plugin = createPlugin();
  const promptText = "confidential newsroom music brief";

  const summary = plugin.summarizeRequestInput([
    {
      type: "text",
      text: promptText,
    },
  ]);

  t.deepEqual(summary, [
    {
      type: "text",
      chars: promptText.length,
    },
  ]);
});

test("GeminiMusicPlugin uses configured Lyria model id", (t) => {
  const plugin = new GeminiMusicPlugin(
    {
      name: "music_lyria_pro",
      prompt: ["{{text}}"],
      inputParameters: {
        text: "",
      },
    },
    {
      name: "google-lyria-3-pro-music",
      type: "GEMINI-MUSIC",
      lyriaModel: "lyria-3-pro-preview",
    },
  );

  const request = plugin.getRequestParameters("brief: full song", {}, {});

  t.is(request.model, "lyria-3-pro-preview");
});

test("GeminiMusicPlugin includes optional Lyria image input", (t) => {
  const plugin = createPlugin();

  const request = plugin.getRequestParameters(
    "brief: music inspired by the selected image",
    {
      input_image: "gs://media-bucket/storyboard-frame.jpg",
    },
    { prompt: "{{text}}" },
  );

  t.deepEqual(request, {
    model: "lyria-3-clip-preview",
    input: [
      {
        type: "text",
        text: "brief: music inspired by the selected image",
      },
      {
        type: "image",
        mime_type: "image/jpeg",
        uri: "gs://media-bucket/storyboard-frame.jpg",
      },
    ],
  });
});

test("GeminiMusicPlugin supports multiple Lyria image inputs", (t) => {
  const plugin = createPlugin();

  const request = plugin.getRequestParameters(
    "brief: music inspired by the selected references",
    {
      input_images: [
        "gs://media-bucket/storyboard-frame.jpg",
        "https://storage.googleapis.com/media-bucket/palette.webp",
      ],
    },
    { prompt: "{{text}}" },
  );

  t.deepEqual(request.input, [
    {
      type: "text",
      text: "brief: music inspired by the selected references",
    },
    {
      type: "image",
      mime_type: "image/jpeg",
      uri: "gs://media-bucket/storyboard-frame.jpg",
    },
    {
      type: "image",
      mime_type: "image/webp",
      uri: "https://storage.googleapis.com/media-bucket/palette.webp",
    },
  ]);
});

test("GeminiMusicPlugin sends data URL images as base64 bytes", (t) => {
  const plugin = createPlugin();

  const request = plugin.getRequestParameters(
    "brief: visual reference",
    {
      input_image: "data:image/png;base64,iVBORw0KGgo=",
    },
    { prompt: "{{text}}" },
  );

  t.deepEqual(request.input[1], {
    type: "image",
    mime_type: "image/png",
    data: "iVBORw0KGgo=",
  });
});

test("GeminiMusicPlugin supports image-only Lyria requests", (t) => {
  const plugin = createPlugin();

  const request = plugin.getRequestParameters(
    "",
    {
      input_image: {
        uri: "https://storage.googleapis.com/media-bucket/frame.webp?token=1",
      },
      input_image_mime_type: "image/webp",
    },
    { prompt: "{{text}}" },
  );

  t.deepEqual(request, {
    model: "lyria-3-clip-preview",
    input: [
      {
        type: "image",
        mime_type: "image/webp",
        uri: "https://storage.googleapis.com/media-bucket/frame.webp?token=1",
      },
    ],
  });
});

test("GeminiMusicPlugin rejects empty Lyria requests with no text or image", (t) => {
  const plugin = createPlugin();

  const error = t.throws(() =>
    plugin.getRequestParameters("", {}, { prompt: "{{text}}" }),
  );

  t.is(
    error.message,
    "Lyria music generation requires a text prompt or image input",
  );
});

test("GeminiMusicPlugin infers raw base64 image mime types", (t) => {
  const plugin = createPlugin();

  const request = plugin.getRequestParameters(
    "",
    {
      input_image: "/9j/base64jpeg",
    },
    { prompt: "{{text}}" },
  );

  t.deepEqual(request.input[0], {
    type: "image",
    mime_type: "image/jpeg",
    data: "/9j/base64jpeg",
  });
});

test("GeminiMusicPlugin exposes inline audio artifacts", (t) => {
  const plugin = createPlugin();

  const parsed = plugin.parseResponse({
    candidates: [
      {
        finishReason: "STOP",
        content: {
          parts: [
            { text: "done" },
            {
              inlineData: {
                data: "base64audio",
                mimeType: "audio/wav",
              },
            },
          ],
        },
      },
    ],
    usageMetadata: { totalTokenCount: 5 },
  });

  t.is(parsed.output_text, "done");
  t.deepEqual(parsed.artifacts, [
    {
      type: "audio",
      data: "base64audio",
      mimeType: "audio/wav",
    },
  ]);
  t.deepEqual(parsed.usage, { totalTokenCount: 5 });
});

test("GeminiMusicPlugin exposes Vertex prediction audio artifacts", (t) => {
  const plugin = createPlugin();

  const parsed = plugin.parseResponse({
    predictions: [
      {
        bytesBase64Encoded: "vertexbase64audio",
        mimeType: "audio/wav",
      },
    ],
  });

  t.deepEqual(parsed.artifacts, [
    {
      type: "audio",
      data: "vertexbase64audio",
      mimeType: "audio/wav",
    },
  ]);
});

test("GeminiMusicPlugin exposes Agent Platform output audio artifacts", (t) => {
  const plugin = createPlugin();

  const parsed = plugin.parseResponse({
    status: "completed",
    outputs: [
      {
        type: "text",
        text: "Generated lyrics",
      },
      {
        type: "audio",
        databytes: "mp3base64audio",
        mime_type: "audio/mpeg",
      },
    ],
  });

  t.is(parsed.output_text, "Generated lyrics");
  t.deepEqual(parsed.artifacts, [
    {
      type: "audio",
      data: "mp3base64audio",
      mimeType: "audio/mpeg",
    },
  ]);
});

test("GeminiMusicPlugin rejects completed Lyria responses without audio artifacts", (t) => {
  const plugin = createPlugin();

  const error = t.throws(() =>
    plugin.parseResponse({
      id: "interaction-1",
      status: "completed",
      model: "lyria-3-clip-preview",
    }),
  );

  t.is(
    error.message,
    "Lyria music generation completed without returning audio artifacts. Try revising the prompt or input image.",
  );
});
