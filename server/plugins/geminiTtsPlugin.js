import ModelPlugin from "./modelPlugin.js";
import CortexResponse from "../../lib/cortexResponse.js";
import logger from "../../lib/logger.js";

const DEFAULT_VOICE_NAME = "Kore";
const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_BITS_PER_SAMPLE = 16;

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function inferSampleRate(mimeType) {
  const match = String(mimeType || "").match(/rate=(\d+)/i);
  return parsePositiveInteger(match?.[1], DEFAULT_SAMPLE_RATE);
}

function isWavMimeType(mimeType) {
  return /^audio\/(wav|wave|x-wav)(;|$)/i.test(String(mimeType || ""));
}

function buildWavBase64(pcmBase64, {
  sampleRate = DEFAULT_SAMPLE_RATE,
  channels = DEFAULT_CHANNELS,
  bitsPerSample = DEFAULT_BITS_PER_SAMPLE,
} = {}) {
  const pcm = Buffer.from(pcmBase64, "base64");
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]).toString("base64");
}

class GeminiTtsPlugin extends ModelPlugin {
  constructor(pathway, model) {
    super(pathway, model);
  }

  buildSpeechConfig(parameters = {}) {
    const speakerVoiceConfigs = [
      {
        speaker: parameters.speaker1Name || parameters.speaker1 || "",
        voiceName: parameters.speaker1VoiceName || parameters.speaker1Voice || "",
      },
      {
        speaker: parameters.speaker2Name || parameters.speaker2 || "",
        voiceName: parameters.speaker2VoiceName || parameters.speaker2Voice || "",
      },
    ].filter((speaker) => speaker.speaker && speaker.voiceName);

    if (speakerVoiceConfigs.length > 0) {
      return {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: speakerVoiceConfigs.slice(0, 2).map((speaker) => ({
            speaker: speaker.speaker,
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: speaker.voiceName,
              },
            },
          })),
        },
      };
    }

    return {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: parameters.voiceName || DEFAULT_VOICE_NAME,
        },
      },
    };
  }

  getRequestParameters(text, parameters, prompt) {
    const { modelPromptText } = this.getCompiledPrompt(text, parameters, prompt);
    const textInput = modelPromptText?.trim() ? modelPromptText : text;

    if (!textInput?.trim()) {
      throw new Error("Gemini TTS requires text to synthesize");
    }

    return {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: textInput,
            },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: this.buildSpeechConfig(parameters),
      },
    };
  }

  async execute(text, parameters, prompt, cortexRequest) {
    const gcpAuthTokenHelper = this.config.get("gcpAuthTokenHelper");
    if (!gcpAuthTokenHelper) {
      throw new Error(
        "GCP_SERVICE_ACCOUNT_KEY is required for Vertex AI Gemini TTS generation",
      );
    }

    const requestParameters = this.getRequestParameters(text, parameters, prompt);
    cortexRequest.data = requestParameters;
    cortexRequest.params = {};
    cortexRequest.stream = false;
    cortexRequest.urlSuffix = ":generateContent";

    logger.info(
      `[GeminiTtsPlugin] Submitting Gemini TTS request ${JSON.stringify({
        chars: requestParameters.contents?.[0]?.parts?.[0]?.text?.length || 0,
        speechConfig: requestParameters.generationConfig?.speechConfig,
      })}`,
    );

    const authToken = await gcpAuthTokenHelper.getAccessToken();
    cortexRequest.auth.Authorization = `Bearer ${authToken}`;

    return this.executeRequest(cortexRequest);
  }

  parseResponse(data) {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const artifacts = [];
    let textContent = "";

    for (const part of parts) {
      const inlineData = part.inlineData || part.inline_data;
      const mimeType = inlineData?.mimeType || inlineData?.mime_type || "audio/pcm;rate=24000";

      if (inlineData?.data) {
        const isWav = isWavMimeType(mimeType);
        artifacts.push({
          type: "audio",
          data: isWav
            ? inlineData.data
            : buildWavBase64(inlineData.data, {
                sampleRate: inferSampleRate(mimeType),
              }),
          mimeType: isWav ? mimeType : "audio/wav",
          metadata: {
            originalMimeType: mimeType,
            sampleRate: inferSampleRate(mimeType),
            channels: DEFAULT_CHANNELS,
            bitsPerSample: DEFAULT_BITS_PER_SAMPLE,
          },
        });
      } else if (part.fileData?.fileUri) {
        artifacts.push({
          type: "audio",
          url: part.fileData.fileUri,
          mimeType: part.fileData.mimeType || "audio/wav",
        });
      } else if (part.text) {
        textContent += part.text;
      }
    }

    if (!artifacts.length) {
      logger.warn(
        `[GeminiTtsPlugin] Gemini TTS response contained no audio artifacts ${JSON.stringify({
          finishReason: data?.candidates?.[0]?.finishReason,
          candidateCount: Array.isArray(data?.candidates) ? data.candidates.length : 0,
          textChars: textContent.length,
        })}`,
      );
      throw new Error(
        textContent
          ? `Gemini TTS returned text instead of audio: ${textContent}`
          : "Gemini TTS completed without returning audio artifacts. Try revising the prompt.",
      );
    }

    return new CortexResponse({
      output_text: textContent,
      artifacts,
      finishReason: data?.candidates?.[0]?.finishReason || "stop",
      usage: data?.usageMetadata || data?.usage || null,
    });
  }
}

export {
  buildWavBase64,
};

export default GeminiTtsPlugin;
