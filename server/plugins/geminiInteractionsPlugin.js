import axios from "axios";
import ModelPlugin from "./modelPlugin.js";
import CortexResponse from "../../lib/cortexResponse.js";
import logger from "../../lib/logger.js";

const DEFAULT_MAX_INPUT_IMAGES = 5;
const DEFAULT_MAX_INPUT_VIDEOS = 1;
const DEFAULT_MAX_INPUT_AUDIO = 1;

class GeminiInteractionsPlugin extends ModelPlugin {
  inferMimeType(value, mediaType, explicitMimeType) {
    if (explicitMimeType) return explicitMimeType;

    const source =
      typeof value === "string"
        ? value
        : value?.uri || value?.url || value?.gcs || value?.data || "";
    const dataUrlMatch = source.match(/^data:([^;,]+)[;,]/i);
    if (dataUrlMatch?.[1]) return dataUrlMatch[1];

    const normalized = source.split("?")[0].toLowerCase();
    if (mediaType === "image") {
      if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg"))
        return "image/jpeg";
      if (normalized.endsWith(".webp")) return "image/webp";
      if (normalized.endsWith(".gif")) return "image/gif";
      if (normalized.startsWith("/9j/")) return "image/jpeg";
      if (normalized.startsWith("r0lg")) return "image/gif";
      if (normalized.startsWith("uklgr")) return "image/webp";
      return "image/png";
    }
    if (mediaType === "video") {
      if (normalized.endsWith(".webm")) return "video/webm";
      if (normalized.endsWith(".mov")) return "video/quicktime";
      return "video/mp4";
    }
    if (mediaType === "audio") {
      if (normalized.endsWith(".wav")) return "audio/wav";
      if (normalized.endsWith(".m4a")) return "audio/mp4";
      if (normalized.endsWith(".ogg")) return "audio/ogg";
      return "audio/mpeg";
    }
    return "application/octet-stream";
  }

  buildMediaInput(mediaType, media, explicitMimeType) {
    const value =
      typeof media === "string"
        ? media
        : media?.uri || media?.url || media?.gcs || media?.data || "";
    if (!value) return null;

    const mimeType = this.inferMimeType(
      media,
      mediaType,
      explicitMimeType || media?.mime_type || media?.mimeType,
    );
    const dataUrlMatch = value.match(/^data:([^;,]+);base64,(.+)$/i);

    if (dataUrlMatch) {
      return {
        type: mediaType,
        mime_type: dataUrlMatch[1] || mimeType,
        data: dataUrlMatch[2],
      };
    }

    if (/^(gs|https?):\/\//i.test(value)) {
      return {
        type: mediaType,
        mime_type: mimeType,
        uri: value,
      };
    }

    return {
      type: mediaType,
      mime_type: mimeType,
      data: value,
    };
  }

  collectMedia(parameters, mediaType, keys, maxCount) {
    const seen = new Set();
    const media = [];

    for (const key of keys) {
      const value = parameters?.[key];
      const values = Array.isArray(value) ? value : [value];
      for (const item of values.filter(Boolean)) {
        const dedupeKey =
          typeof item === "string"
            ? item
            : item?.uri || item?.url || item?.gcs || item?.data;
        if (dedupeKey && seen.has(dedupeKey)) continue;
        if (dedupeKey) seen.add(dedupeKey);

        const built = this.buildMediaInput(
          mediaType,
          item,
          parameters?.[`${key}_mime_type`],
        );
        if (built) media.push(built);
        if (media.length >= maxCount) return media;
      }
    }

    return media;
  }

  buildMediaInputs(parameters) {
    return [
      ...this.collectMedia(
        parameters,
        "image",
        ["input_images", "inputImages", "input_image", "inputImage"],
        this.model.maxInputImages || DEFAULT_MAX_INPUT_IMAGES,
      ),
      ...this.collectMedia(
        parameters,
        "video",
        ["input_videos", "inputVideos", "input_video", "inputVideo"],
        this.model.maxInputVideos || DEFAULT_MAX_INPUT_VIDEOS,
      ),
      ...this.collectMedia(
        parameters,
        "audio",
        [
          "input_audios",
          "inputAudios",
          "input_audio",
          "inputAudio",
          "audio",
          "audioUrl",
          "inputAudioUrl",
        ],
        this.model.maxInputAudio || DEFAULT_MAX_INPUT_AUDIO,
      ),
    ];
  }

  summarizeRequestInput(input) {
    return input.map((part) => {
      if (part.type === "text") {
        return {
          type: "text",
          chars: part.text?.length || 0,
        };
      }
      return {
        type: part.type,
        mime_type: part.mime_type,
        source: part.uri ? "uri" : "data",
        uri: part.uri ? part.uri.split("?")[0] : undefined,
        dataBytes: part.data ? part.data.length : undefined,
      };
    });
  }

  getRequestParameters(text, parameters, prompt) {
    const { modelPromptText } = this.getCompiledPrompt(
      text,
      parameters,
      prompt,
    );
    const input = [];
    const textInput = modelPromptText?.trim() ? modelPromptText : text;

    if (textInput?.trim()) {
      input.push({
        type: "text",
        text: textInput,
      });
    }
    input.push(...this.buildMediaInputs(parameters));

    if (!input.length) {
      throw new Error(
        "Gemini interactions generation requires a text prompt or media input",
      );
    }

    return {
      model:
        this.model.interactionsModel ||
        parameters?.interactionsModel ||
        parameters?.model ||
        this.modelName,
      input,
    };
  }

  async execute(text, parameters, prompt, cortexRequest) {
    const gcpAuthTokenHelper = this.config.get("gcpAuthTokenHelper");
    if (!gcpAuthTokenHelper) {
      throw new Error(
        "GCP_SERVICE_ACCOUNT_KEY is required for Vertex AI Gemini interactions",
      );
    }

    const requestParameters = this.getRequestParameters(
      text,
      parameters,
      prompt,
    );
    cortexRequest.data = requestParameters;
    logger.info(
      `[GeminiInteractionsPlugin] Submitting request ${JSON.stringify({
        model: requestParameters.model,
        input: this.summarizeRequestInput(requestParameters.input),
      })}`,
    );

    const authToken = await gcpAuthTokenHelper.getAccessToken();

    try {
      const response = await axios({
        method: "POST",
        url: cortexRequest.url,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
          ...cortexRequest.headers,
        },
        data: requestParameters,
      });
      return this.parseResponse(response.data);
    } catch (error) {
      const status = error?.response?.status;
      const details = error?.response?.data?.error?.message || error?.message;
      throw new Error(
        `Gemini interactions request failed${status ? ` (${status})` : ""}: ${details}`,
      );
    }
  }

  parseResponse(data) {
    const artifacts = [];
    let textContent = "";
    const steps = Array.isArray(data?.steps) ? data.steps : [];

    for (const step of steps) {
      if (step.type === "thought") continue;
      const contents = Array.isArray(step.content) ? step.content : [];
      for (const content of contents) {
        if (content?.type === "text" && content.text) {
          textContent += textContent ? `\n${content.text}` : content.text;
          continue;
        }

        if (["image", "video", "audio"].includes(content?.type)) {
          const artifact = {
            type: content.type,
            mimeType: content.mime_type || content.mimeType,
          };
          if (content.data) artifact.data = content.data;
          if (content.uri || content.url)
            artifact.url = content.uri || content.url;
          if (artifact.data || artifact.url) artifacts.push(artifact);
        }
      }
    }

    if (!artifacts.length) {
      logger.warn(
        `[GeminiInteractionsPlugin] Response contained no media artifacts ${JSON.stringify({
          id: data?.id,
          status: data?.status,
          model: data?.model,
          stepCount: steps.length,
        })}`,
      );
      throw new Error(
        "Gemini interactions request completed without returning media artifacts. Try revising the prompt or input media.",
      );
    }

    return new CortexResponse({
      output_text: textContent,
      artifacts,
      finishReason: data?.status || "completed",
      usage: data?.usage || null,
      metadata: {
        interactionId: data?.id,
        interactionModel: data?.model,
        interactionStatus: data?.status,
      },
    });
  }
}

export default GeminiInteractionsPlugin;
