import test from "ava";
import mediaGenerate, {
  PARAM_MAPPERS,
} from "../../../pathways/media_generate.js";
import musicLyria from "../../../pathways/music_lyria.js";
import musicReplicate from "../../../pathways/music_replicate.js";
import ttsReplicate from "../../../pathways/tts_replicate.js";
import { PathwayResolver } from "../../../server/pathwayResolver.js";

test("media_generate maps Lyria to filtered input images", (t) => {
  const mapped = PARAM_MAPPERS.music_lyria(
    {
      text: "music inspired by a selected image",
      inputImages: ["", "gs://unfiltered-should-not-win.png"],
      contextId: "ctx-1",
    },
    ["gs://bucket/reference.png", "gs://bucket/reference-2.png"],
  );

  t.deepEqual(mapped, {
    text: "music inspired by a selected image",
    input_images: ["gs://bucket/reference.png", "gs://bucket/reference-2.png"],
    input_image: "gs://bucket/reference.png",
    contextId: "ctx-1",
  });
});

test("media_generate maps Lyria Pro through the same image input contract", (t) => {
  const mapped = PARAM_MAPPERS.music_lyria_pro(
    {
      text: "full song from the reference frame",
      contextId: "ctx-2",
    },
    ["https://storage.googleapis.com/bucket/frame.webp"],
  );

  t.deepEqual(mapped, {
    text: "full song from the reference frame",
    input_images: ["https://storage.googleapis.com/bucket/frame.webp"],
    input_image: "https://storage.googleapis.com/bucket/frame.webp",
    contextId: "ctx-2",
  });
});

test("media_generate maps Replicate music controls as API parameters", (t) => {
  const mapped = PARAM_MAPPERS.music_replicate({
    text: "17 second cello sting",
    model: "replicate-elevenlabs-music",
    duration: 17,
    outputFormat: "wav_cd_quality",
    forceInstrumental: false,
  });

  t.deepEqual(mapped, {
    text: "17 second cello sting",
    model: "replicate-elevenlabs-music",
    duration: 17,
    outputFormat: "wav_cd_quality",
    forceInstrumental: false,
  });
});

test("media_generate defaults Replicate music to native WAV and instrumental output", (t) => {
  const mapped = PARAM_MAPPERS.music_replicate({
    text: "short news bed",
    model: "replicate-elevenlabs-music",
  });

  t.deepEqual(mapped, {
    text: "short news bed",
    model: "replicate-elevenlabs-music",
    duration: 10,
    outputFormat: "wav_cd_quality",
    forceInstrumental: true,
  });
});

test("music_replicate timeout outlasts Replicate audio polling", (t) => {
  t.true(musicReplicate.timeout >= 60 * 15);
});

test("media_generate forwards MiniMax music controls without fake duration", (t) => {
  const mapped = PARAM_MAPPERS.music_replicate({
    text: "cinematic cello layer",
    model: "replicate-minimax-music-26",
    audioFormat: "wav",
    sampleRate: 44100,
    bitrate: 256000,
    isInstrumental: true,
    lyricsOptimizer: false,
    duration: 10,
    outputFormat: "wav_cd_quality",
  });

  t.deepEqual(mapped, {
    text: "cinematic cello layer",
    model: "replicate-minimax-music-26",
    audioFormat: "wav",
    sampleRate: 44100,
    bitrate: 256000,
    isInstrumental: true,
    lyricsOptimizer: false,
  });
  t.false("duration" in mapped);
  t.false("outputFormat" in mapped);
});

test("media_generate forwards MiniMax cover audio URL", (t) => {
  const mapped = PARAM_MAPPERS.music_replicate({
    text: "cover as orchestral strings",
    model: "replicate-minimax-music-cover",
    inputAudioUrl: "https://example.com/source.wav",
    audioFormat: "wav",
    sampleRate: 44100,
    bitrate: 256000,
  });

  t.deepEqual(mapped, {
    text: "cover as orchestral strings",
    model: "replicate-minimax-music-cover",
    inputAudioUrl: "https://example.com/source.wav",
  });
});

test("media_generate normalizes every music pathway through audio artifacts", (t) => {
  t.regex(
    String(mediaGenerate.executePathway),
    /pathwayName\.startsWith\(["']music_["']\)/,
  );
});

test("media_generate maps Gemini TTS voice controls", (t) => {
  const mapped = PARAM_MAPPERS.tts_gemini({
    text: "Say calmly: Have a productive day.",
    voiceName: "Kore",
    speaker1Name: "Host",
    speaker1VoiceName: "Charon",
    speaker2Name: "Guest",
    speaker2VoiceName: "Puck",
  });

  t.deepEqual(mapped, {
    text: "Say calmly: Have a productive day.",
    voiceName: "Kore",
    speaker1Name: "Host",
    speaker1VoiceName: "Charon",
    speaker2Name: "Guest",
    speaker2VoiceName: "Puck",
  });
});

test("media_generate maps Replicate Qwen3 TTS controls", (t) => {
  const mapped = PARAM_MAPPERS.tts_replicate({
    text: "Hello, I'm Aiden and it's very nice to meet you",
    model: "replicate-qwen3-tts",
    mode: "voice_clone",
    language: "English",
    speaker: "Aiden",
    inputAudioUrl: "https://example.com/reference.wav",
    referenceText: "Reference transcript.",
    styleInstruction: "Speak cheerfully.",
    voiceDescription: "A warm presenter voice",
  });

  t.deepEqual(mapped, {
    text: "Hello, I'm Aiden and it's very nice to meet you",
    model: "replicate-qwen3-tts",
    mode: "voice_clone",
    language: "English",
    speaker: "Aiden",
    inputAudioUrl: "https://example.com/reference.wav",
    referenceText: "Reference transcript.",
    styleInstruction: "Speak cheerfully.",
    voiceDescription: "A warm presenter voice",
  });
});

test("media_generate maps Replicate ElevenLabs v3 TTS controls", (t) => {
  const mapped = PARAM_MAPPERS.tts_replicate({
    text: "Tell this as a warm fantasy narration.",
    model: "replicate-elevenlabs-v3",
    voice: "Grimblewood",
    stability: 0.6,
    similarityBoost: 0.8,
    style: 0.25,
    speed: 1.1,
    previousText: "The chapter opened softly.",
    nextText: "The next line became quieter.",
    languageCode: "en",
  });

  t.deepEqual(mapped, {
    text: "Tell this as a warm fantasy narration.",
    model: "replicate-elevenlabs-v3",
    voice: "Grimblewood",
    stability: 0.6,
    similarityBoost: 0.8,
    style: 0.25,
    speed: 1.1,
    previousText: "The chapter opened softly.",
    nextText: "The next line became quieter.",
    languageCode: "en",
  });
});

test("media_generate maps Replicate MiniMax Speech 2.8 TTS controls", (t) => {
  const mapped = PARAM_MAPPERS.tts_replicate({
    text: "Hello world from MiniMax Speech 2.8.",
    model: "replicate-minimax-speech-2.8-hd",
    voiceId: "Wise_Woman",
    customVoiceId: "voice-clone-123",
    speed: 1.25,
    volume: 1.5,
    pitch: -2,
    emotion: "calm",
    audioFormat: "wav",
    sampleRate: 44100,
    bitrate: 256000,
    channel: "stereo",
    languageBoost: "English",
    subtitleEnable: true,
    englishNormalization: true,
  });

  t.deepEqual(mapped, {
    text: "Hello world from MiniMax Speech 2.8.",
    model: "replicate-minimax-speech-2.8-hd",
    voiceId: "Wise_Woman",
    customVoiceId: "voice-clone-123",
    speed: 1.25,
    volume: 1.5,
    pitch: -2,
    emotion: "calm",
    audioFormat: "wav",
    sampleRate: 44100,
    bitrate: 256000,
    channel: "stereo",
    languageBoost: "English",
    subtitleEnable: true,
    englishNormalization: true,
  });
});

test("tts_replicate lets media_generate override the default Replicate TTS model", (t) => {
  const endpoints = {
    "replicate-qwen3-tts": {
      name: "replicate-qwen3-tts",
      type: "REPLICATE-API",
    },
    "replicate-minimax-speech-2.8-hd": {
      name: "replicate-minimax-speech-2.8-hd",
      type: "REPLICATE-API",
    },
  };
  const resolver = new PathwayResolver({
    config: {
      get: (key) => (key === "defaultModelName" ? "replicate-qwen3-tts" : {}),
    },
    pathway: ttsReplicate,
    args: {
      text: "Hello world from MiniMax Speech 2.8.",
      model: "replicate-minimax-speech-2.8-hd",
    },
    endpoints,
  });

  t.is(resolver.modelName, "replicate-minimax-speech-2.8-hd");
});

test("media_generate normalizes TTS pathways through audio artifacts", (t) => {
  t.regex(
    String(mediaGenerate.executePathway),
    /pathwayName\.startsWith\(["']tts_["']\)/,
  );
});

test("media_generate and Lyria pathways do not expose fake audio settings", (t) => {
  for (const pathway of [mediaGenerate, musicLyria]) {
    t.false("audioUseCase" in pathway.inputParameters);
    t.false("audioStyle" in pathway.inputParameters);
    t.false("audioMood" in pathway.inputParameters);
  }
});
