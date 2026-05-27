import axios from "axios";
import ModelPlugin from "./modelPlugin.js";
import CortexResponse from "../../lib/cortexResponse.js";
import logger from "../../lib/logger.js";

const MAX_LYRIA_INPUT_IMAGES = 10;

class GeminiMusicPlugin extends ModelPlugin {
  constructor(pathway, model) {
    super(pathway, model);
  }

  inferImageMimeType(image, explicitMimeType) {
    if (explicitMimeType) return explicitMimeType;

    const value =
      typeof image === "string"
        ? image
        : image?.uri || image?.url || image?.data || "";

    const dataUrlMatch = value.match(/^data:([^;,]+)[;,]/i);
    if (dataUrlMatch?.[1]) return dataUrlMatch[1];

    const normalized = value.split("?")[0].toLowerCase();
    if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) {
      return "image/jpeg";
    }
    if (normalized.endsWith(".webp")) return "image/webp";
    if (normalized.endsWith(".gif")) return "image/gif";
    if (normalized.startsWith("/9j/")) return "image/jpeg";
    if (normalized.startsWith("r0lg")) return "image/gif";
    if (normalized.startsWith("uklgr")) return "image/webp";
    return "image/png";
  }

  buildImageInput(image, explicitMimeType) {
    const value =
      typeof image === "string"
        ? image
        : image?.uri || image?.url || image?.gcs || image?.data || "";

    if (!value) return null;

    const mimeType = this.inferImageMimeType(
      value,
      explicitMimeType || image?.mime_type || image?.mimeType,
    );
    const dataUrlMatch = value.match(/^data:([^;,]+);base64,(.+)$/i);

    if (dataUrlMatch) {
      return {
        type: "image",
        mime_type: dataUrlMatch[1] || mimeType,
        data: dataUrlMatch[2],
      };
    }

    if (/^(gs|https?):\/\//i.test(value)) {
      return {
        type: "image",
        mime_type: mimeType,
        uri: value,
      };
    }

    return {
      type: "image",
      mime_type: mimeType,
      data: value,
    };
  }

  buildImageInputs(parameters) {
    const images = [];
    const seen = new Set();
    for (const image of [
      ...(Array.isArray(parameters?.input_images)
        ? parameters.input_images
        : []),
      ...(Array.isArray(parameters?.inputImages) ? parameters.inputImages : []),
      parameters?.input_image || parameters?.inputImage,
    ].filter(Boolean)) {
      const key =
        typeof image === "string"
          ? image
          : image?.uri || image?.url || image?.gcs || image?.data;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      images.push(image);
    }

    return images
      .slice(0, MAX_LYRIA_INPUT_IMAGES)
      .map((image) =>
        this.buildImageInput(
          image,
          parameters?.input_image_mime_type || parameters?.inputImageMimeType,
        ),
      )
      .filter(Boolean);
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
        type: "image",
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
    input.push(...this.buildImageInputs(parameters));

    if (!input.length) {
      throw new Error(
        "Lyria music generation requires a text prompt or image input",
      );
    }

    return {
      model: this.model.lyriaModel || "lyria-3-clip-preview",
      input,
    };
  }

  async execute(text, parameters, prompt, cortexRequest) {
    const gcpAuthTokenHelper = this.config.get("gcpAuthTokenHelper");
    if (!gcpAuthTokenHelper) {
      throw new Error(
        "GCP_SERVICE_ACCOUNT_KEY is required for Vertex AI Lyria music generation",
      );
    }

    const requestParameters = this.getRequestParameters(
      text,
      parameters,
      prompt,
    );
    cortexRequest.data = requestParameters;
    logger.info(
      `[GeminiMusicPlugin] Submitting Lyria request ${JSON.stringify({
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
        `Lyria music generation failed${status ? ` (${status})` : ""}: ${details}`,
      );
    }
  }

  parseResponse(data) {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const predictions = Array.isArray(data?.predictions)
      ? data.predictions
      : [];
    const outputs = Array.isArray(data?.outputs) ? data.outputs : [];
    const artifacts = [];
    let textContent = "";

    for (const part of parts) {
      if (part.inlineData?.data) {
        artifacts.push({
          type: "audio",
          data: part.inlineData.data,
          mimeType: part.inlineData.mimeType || "audio/wav",
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

    for (const prediction of predictions) {
      const candidates = [
        prediction?.bytesBase64Encoded,
        prediction?.audioContent,
        prediction?.audio,
        prediction?.data,
      ].filter(Boolean);

      for (const candidate of candidates) {
        if (typeof candidate === "string") {
          artifacts.push({
            type: "audio",
            data: candidate,
            mimeType: prediction?.mimeType || "audio/wav",
          });
          break;
        }
      }

      const uri = prediction?.gcsUri || prediction?.uri || prediction?.url;
      if (uri) {
        artifacts.push({
          type: "audio",
          url: uri,
          mimeType: prediction?.mimeType || "audio/wav",
        });
      }
    }

    for (const output of outputs) {
      if (output?.type === "text" && output.text) {
        textContent += textContent ? `\n${output.text}` : output.text;
        continue;
      }

      const audioData = [
        output?.databytes,
        output?.dataBytes,
        output?.bytesBase64Encoded,
        output?.audioContent,
        output?.data,
      ].find((value) => typeof value === "string" && value.length > 0);

      if (audioData) {
        artifacts.push({
          type: "audio",
          data: audioData,
          mimeType: output?.mime_type || output?.mimeType || "audio/mpeg",
        });
      }

      const outputUri =
        output?.gcs_uri || output?.gcsUri || output?.uri || output?.url;
      if (outputUri) {
        artifacts.push({
          type: "audio",
          url: outputUri,
          mimeType: output?.mime_type || output?.mimeType || "audio/mpeg",
        });
      }
    }

    if (!artifacts.length) {
      logger.warn(
        `[GeminiMusicPlugin] Lyria response contained no audio artifacts ${JSON.stringify({
          id: data?.id,
          status: data?.status,
          model: data?.model,
          finishReason: data?.candidates?.[0]?.finishReason,
          candidateCount: Array.isArray(data?.candidates)
            ? data.candidates.length
            : 0,
          predictionCount: Array.isArray(data?.predictions)
            ? data.predictions.length
            : 0,
          outputCount: Array.isArray(data?.outputs) ? data.outputs.length : 0,
        })}`,
      );
      throw new Error(
        "Lyria music generation completed without returning audio artifacts. Try revising the prompt or input image.",
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

export default GeminiMusicPlugin;
