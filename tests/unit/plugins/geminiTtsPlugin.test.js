import test from "ava";
import GeminiTtsPlugin, {
  buildWavBase64,
} from "../../../server/plugins/geminiTtsPlugin.js";

function createPlugin() {
  return new GeminiTtsPlugin(
    {
      name: "tts_gemini",
      prompt: ["{{text}}"],
      inputParameters: {
        text: "",
        voiceName: "Kore",
      },
    },
    {
      name: "google-gemini-3.1-flash-tts",
      type: "GEMINI-TTS",
    },
  );
}

test("GeminiTtsPlugin requests Gemini audio modality with a prebuilt voice", (t) => {
  const plugin = createPlugin();

  const request = plugin.getRequestParameters(
    "Say cheerfully: Have a wonderful day!",
    {
      voiceName: "Kore",
    },
    { prompt: "{{text}}" },
  );

  t.deepEqual(request, {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: "Say cheerfully: Have a wonderful day!",
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: "Kore",
          },
        },
      },
    },
  });
});

test("GeminiTtsPlugin supports two-speaker voice config", (t) => {
  const plugin = createPlugin();

  const request = plugin.getRequestParameters(
    "Host: Welcome.\nGuest: Thanks.",
    {
      speaker1Name: "Host",
      speaker1VoiceName: "Charon",
      speaker2Name: "Guest",
      speaker2VoiceName: "Puck",
    },
    { prompt: "{{text}}" },
  );

  t.deepEqual(request.generationConfig.speechConfig, {
    multiSpeakerVoiceConfig: {
      speakerVoiceConfigs: [
        {
          speaker: "Host",
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: "Charon",
            },
          },
        },
        {
          speaker: "Guest",
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: "Puck",
            },
          },
        },
      ],
    },
  });
});

test("GeminiTtsPlugin rejects empty synthesis requests", (t) => {
  const plugin = createPlugin();

  const error = t.throws(() =>
    plugin.getRequestParameters("", {}, { prompt: "{{text}}" }),
  );

  t.is(error.message, "Gemini TTS requires text to synthesize");
});

test("buildWavBase64 wraps signed 16-bit PCM with a RIFF header", (t) => {
  const pcmBase64 = Buffer.from([0x01, 0x00, 0xff, 0x7f]).toString("base64");
  const wav = Buffer.from(buildWavBase64(pcmBase64), "base64");

  t.is(wav.toString("ascii", 0, 4), "RIFF");
  t.is(wav.toString("ascii", 8, 12), "WAVE");
  t.is(wav.toString("ascii", 36, 40), "data");
  t.is(wav.readUInt32LE(24), 24000);
  t.is(wav.readUInt16LE(22), 1);
  t.is(wav.readUInt16LE(34), 16);
  t.is(wav.readUInt32LE(40), 4);
});

test("GeminiTtsPlugin exposes Gemini PCM as WAV audio artifacts", (t) => {
  const plugin = createPlugin();
  const pcmBase64 = Buffer.from([0x00, 0x00, 0x01, 0x00]).toString("base64");

  const parsed = plugin.parseResponse({
    candidates: [
      {
        finishReason: "STOP",
        content: {
          parts: [
            {
              inlineData: {
                data: pcmBase64,
                mimeType: "audio/pcm;rate=24000",
              },
            },
          ],
        },
      },
    ],
    usageMetadata: { totalTokenCount: 12 },
  });

  t.is(parsed.output_text, "");
  t.is(parsed.artifacts[0].type, "audio");
  t.is(parsed.artifacts[0].mimeType, "audio/wav");
  t.is(
    Buffer.from(parsed.artifacts[0].data, "base64").toString("ascii", 0, 4),
    "RIFF",
  );
  t.deepEqual(parsed.usage, { totalTokenCount: 12 });
});

test("GeminiTtsPlugin rejects text-only responses", (t) => {
  const plugin = createPlugin();

  const error = t.throws(() =>
    plugin.parseResponse({
      candidates: [
        {
          content: {
            parts: [
              {
                text: "I cannot synthesize that request.",
              },
            ],
          },
        },
      ],
    }),
  );

  t.is(
    error.message,
    "Gemini TTS returned text instead of audio: I cannot synthesize that request.",
  );
});
