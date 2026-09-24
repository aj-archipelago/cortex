import axios from "axios";
import FormData from "form-data";
import ModelPlugin from "./modelPlugin.js";

export function buildMaiImageInput(text, parameters, deployment) {
  if (!text?.trim()) throw new Error("MAI image generation requires a prompt");
  if (!deployment || deployment.includes("{{"))
    throw new Error("AZURE_MAI_IMAGE_DEPLOYMENT is required");
  const body = {
    model: deployment,
    prompt: text,
    auto_aspect_ratio: parameters.autoAspectRatio ?? false,
    web_grounding: parameters.webGrounding ?? false,
  };
  if (!parameters.input_image && !body.auto_aspect_ratio) {
    const match = (parameters.size || "1024x1024").match(/^(\d+)x(\d+)$/);
    if (!match) throw new Error("MAI size must be WIDTHxHEIGHT");
    const [, width, height] = match.map(Number);
    if (width < 768 || height < 768 || width * height > 1048576)
      throw new Error(
        "MAI dimensions must be at least 768px and at most 1048576 total pixels",
      );
    Object.assign(body, { width, height });
  }
  return body;
}

export default class AzureMaiImagePlugin extends ModelPlugin {
  async execute(text, parameters, _, request) {
    const deployment = process.env.AZURE_MAI_IMAGE_DEPLOYMENT;
    const body = buildMaiImageInput(text, parameters, deployment);
    const endpoint = process.env.AZURE_MAI_IMAGE_ENDPOINT;
    const key = process.env.AZURE_MAI_IMAGE_KEY;
    if (!endpoint || !key)
      throw new Error("Azure MAI image endpoint and key are required");
    const url = new URL(endpoint);
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".services.ai.azure.com") ||
      url.username ||
      url.password
    )
      throw new Error("MAI requires an Azure Foundry HTTPS endpoint");
    let data = body;
    let headers = { "api-key": key, "Content-Type": "application/json" };
    const edit = Boolean(parameters.input_image);
    if (edit) {
      const source = parameters.input_image;
      let buffer, contentType;
      const inline = source.match(/^data:(image\/(?:png|jpeg));base64,(.+)$/);
      if (inline) {
        contentType = inline[1];
        buffer = Buffer.from(inline[2], "base64");
      } else {
        const image = await axios.get(source, {
          responseType: "arraybuffer",
          timeout: 30000,
          maxContentLength: 20 * 1024 * 1024,
        });
        buffer = Buffer.from(image.data);
        contentType = image.headers["content-type"]?.split(";")[0];
      }
      if (!["image/png", "image/jpeg"].includes(contentType))
        throw new Error("MAI edits require PNG or JPEG input");
      data = new FormData();
      for (const [key, value] of Object.entries(body))
        data.append(key, String(value));
      data.append("image", buffer, {
        filename: contentType === "image/png" ? "input.png" : "input.jpg",
        contentType,
      });
      headers = { "api-key": key, ...data.getHeaders() };
    }
    try {
      const response = await axios.post(
        `${url.origin}/mai/v1/images/${edit ? "edits" : "generations"}`,
        data,
        {
          headers,
          timeout: (request.pathway?.timeout || 600) * 1000,
          maxBodyLength: 25 * 1024 * 1024,
          maxContentLength: 25 * 1024 * 1024,
        },
      );
      if (!response.data?.data?.some((image) => image.b64_json))
        throw new Error("MAI returned no image");
      return JSON.stringify(response.data);
    } catch (error) {
      // Never expose axios request configuration (contains the API key).
      throw new Error(
        `MAI image request failed${error.response?.status ? ` (${error.response.status})` : ""}`,
      );
    }
  }
}
