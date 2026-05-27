import test from "ava";
import mediaPromptAssistant from "../../../pathways/media_prompt_assistant.js";

function createResolver() {
  return {
    pathway: {
      inputParameters: mediaPromptAssistant.inputParameters,
    },
  };
}

test("media prompt assistant uses the default OpenAI vision model", (t) => {
  t.is(mediaPromptAssistant.model, "oai-gpt4o");
});

test("media prompt assistant optimizes supplied prompts with model and reference context", async (t) => {
  const resolver = createResolver();

  const result = await mediaPromptAssistant.executePathway({
    args: {
      prompt: "make this more cinematic",
      mediaType: "video",
      model: "replicate-seedance-2.0",
      references: ["https://example.com/reference.jpg"],
      referenceRoles: ["start_frame"],
    },
    resolver,
    runAllPrompts: async () => "optimized prompt",
  });

  t.is(result, "optimized prompt");
  const [systemMessage, userMessage] = resolver.pathwayPrompt[0].messages;
  t.regex(systemMessage.content, /Media type: video/);
  t.regex(systemMessage.content, /Model: replicate-seedance-2\.0/);
  t.regex(systemMessage.content, /Roles: start_frame/);
  t.regex(systemMessage.content, /Seedance 2\.0 guidance/);
  t.regex(systemMessage.content, /evade safety systems/);
  t.regex(userMessage.content, /Optimize this video prompt/);
  t.regex(userMessage.content, /make this more cinematic/);
});

test("media prompt assistant generates a starter prompt when prompt is empty", async (t) => {
  const resolver = createResolver();

  await mediaPromptAssistant.executePathway({
    args: {
      prompt: "",
      mediaType: "audio",
      model: "google-lyria-3-music",
      hasInputImages: true,
    },
    resolver,
    runAllPrompts: async () => "starter prompt",
  });

  const [systemMessage, userMessage] = resolver.pathwayPrompt[0].messages;
  t.regex(systemMessage.content, /Generic audio guidance/);
  t.regex(systemMessage.content, /Lyria guidance/);
  t.regex(systemMessage.content, /one or more image references/);
  t.regex(userMessage.content, /Generate a strong starter audio prompt/);
});

test("media prompt assistant applies Gemini TTS prompting conventions", async (t) => {
  const resolver = createResolver();

  await mediaPromptAssistant.executePathway({
    args: {
      prompt: "read this as an urgent news explainer: the talks resumed at dawn",
      mediaType: "tts",
      model: "google-gemini-3.1-flash-tts",
    },
    resolver,
    runAllPrompts: async () => "tts prompt",
  });

  const [systemMessage, userMessage] = resolver.pathwayPrompt[0].messages;
  t.regex(systemMessage.content, /Media type: tts/);
  t.regex(systemMessage.content, /Generic text-to-speech guidance/);
  t.regex(systemMessage.content, /Gemini TTS guidance/);
  t.regex(systemMessage.content, /Synthesize the spoken audio for the transcript below/);
  t.regex(systemMessage.content, /TRANSCRIPT/);
  t.regex(systemMessage.content, /AUDIO PROFILE/);
  t.regex(systemMessage.content, /DIRECTOR'S NOTES/);
  t.regex(systemMessage.content, /\[whispers\]/);
  t.regex(systemMessage.content, /Use at most two speakers/);
  t.regex(systemMessage.content, /Do not include model settings/);
  t.regex(userMessage.content, /Optimize this tts prompt/);
});

test("media prompt assistant infers Gemini TTS guidance even when category is generic audio", async (t) => {
  const resolver = createResolver();

  await mediaPromptAssistant.executePathway({
    args: {
      prompt: "",
      category: "audio",
      model: "tts_gemini",
    },
    resolver,
    runAllPrompts: async () => "starter prompt",
  });

  const [systemMessage] = resolver.pathwayPrompt[0].messages;
  t.regex(systemMessage.content, /Generic audio guidance/);
  t.regex(systemMessage.content, /Gemini TTS guidance/);
  t.notRegex(systemMessage.content, /Lyria guidance/);
});

test("media prompt assistant applies Qwen3 TTS prompting guidance", async (t) => {
  const resolver = createResolver();

  await mediaPromptAssistant.executePathway({
    args: {
      prompt: "say hello in an excited preset voice",
      mediaType: "tts",
      model: "replicate-qwen3-tts",
    },
    resolver,
    runAllPrompts: async () => "qwen tts prompt",
  });

  const [systemMessage, userMessage] = resolver.pathwayPrompt[0].messages;
  t.regex(systemMessage.content, /Generic text-to-speech guidance/);
  t.regex(systemMessage.content, /Qwen3 TTS guidance/);
  t.regex(systemMessage.content, /style_instruction, speaker, language, and voice mode controls/);
  t.regex(systemMessage.content, /Do not include model settings/);
  t.notRegex(systemMessage.content, /Gemini TTS guidance/);
  t.regex(userMessage.content, /Optimize this tts prompt/);
});
