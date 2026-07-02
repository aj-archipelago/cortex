import test from "ava";
import GeminiInteractionsPlugin from "../../../server/plugins/geminiInteractionsPlugin.js";

function createPlugin() {
  return new GeminiInteractionsPlugin(
    {
      name: "video_gemini_omni",
      prompt: ["{{{text}}}"],
      inputParameters: {
        text: "",
      },
    },
    {
      name: "gemini-omni-flash-preview",
      type: "GEMINI-INTERACTIONS",
      interactionsModel: "gemini-omni-flash-preview",
    },
  );
}

test("GeminiInteractionsPlugin requests Vertex interactions input", (t) => {
  const plugin = createPlugin();

  const request = plugin.getRequestParameters(
    "Generate a short video of a newsroom opening shot",
    {},
    { prompt: "{{{text}}}" },
  );

  t.deepEqual(request, {
    model: "gemini-omni-flash-preview",
    input: [
      {
        type: "text",
        text: "Generate a short video of a newsroom opening shot",
      },
    ],
  });
});

test("GeminiInteractionsPlugin supports image, video, and audio inputs", (t) => {
  const plugin = createPlugin();

  const request = plugin.getRequestParameters(
    "Animate the selected reference",
    {
      input_images: [
        "gs://media-bucket/frame.jpg",
        "data:image/png;base64,iVBORw0KGgo=",
      ],
      input_videos: ["https://storage.googleapis.com/media-bucket/motion.webm"],
      input_audios: ["gs://media-bucket/music.wav"],
    },
    { prompt: "{{{text}}}" },
  );

  t.deepEqual(request.input, [
    {
      type: "text",
      text: "Animate the selected reference",
    },
    {
      type: "image",
      mime_type: "image/jpeg",
      uri: "gs://media-bucket/frame.jpg",
    },
    {
      type: "image",
      mime_type: "image/png",
      data: "iVBORw0KGgo=",
    },
    {
      type: "video",
      mime_type: "video/webm",
      uri: "https://storage.googleapis.com/media-bucket/motion.webm",
    },
    {
      type: "audio",
      mime_type: "audio/wav",
      uri: "gs://media-bucket/music.wav",
    },
  ]);
});

test("GeminiInteractionsPlugin exposes interaction video artifacts", (t) => {
  const plugin = createPlugin();

  const parsed = plugin.parseResponse({
    id: "interaction-1",
    model: "gemini-omni-flash-preview",
    status: "completed",
    usage: {
      total_tokens: 479,
    },
    steps: [
      {
        type: "thought",
        summary: [
          {
            type: "text",
            text: "reasoning summary",
          },
        ],
      },
      {
        type: "model_output",
        content: [
          {
            type: "text",
            text: "Generated video",
          },
          {
            type: "video",
            data: "base64video",
            mime_type: "video/mp4",
          },
        ],
      },
    ],
  });

  t.is(parsed.output_text, "Generated video");
  t.deepEqual(parsed.artifacts, [
    {
      type: "video",
      data: "base64video",
      mimeType: "video/mp4",
    },
  ]);
  t.deepEqual(parsed.usage, {
    total_tokens: 479,
  });
  t.is(parsed.metadata.interactionId, "interaction-1");
  t.is(parsed.metadata.interactionStatus, "completed");
});

test("GeminiInteractionsPlugin rejects responses without media artifacts", (t) => {
  const plugin = createPlugin();

  const error = t.throws(() =>
    plugin.parseResponse({
      id: "interaction-1",
      status: "completed",
      model: "gemini-omni-flash-preview",
      steps: [
        {
          type: "model_output",
          content: [{ type: "text", text: "No media" }],
        },
      ],
    }),
  );

  t.is(
    error.message,
    "Gemini interactions request completed without returning media artifacts. Try revising the prompt or input media.",
  );
});
