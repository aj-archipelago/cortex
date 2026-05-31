import test from "ava";
import { readFile } from "fs/promises";
import configExample from "../../../config/default.example.json" with { type: "json" };
import imageGptImage2 from "../../../pathways/image_gpt_image_2.js";
import mediaGenerate, {
  PARAM_MAPPERS,
} from "../../../pathways/media_generate.js";
import sysModelMetadata from "../../../pathways/system/sys_model_metadata.js";

test("image_gpt_image_2 declares the Azure OpenAI image pathway contract", (t) => {
  t.is(imageGptImage2.model, "oai-gpt-image-2");
  t.is(imageGptImage2.timeout, 600);
  t.is(imageGptImage2.inputParameters.text, "");
  t.is(imageGptImage2.inputParameters.size, "");
  t.is(imageGptImage2.inputParameters.quality, "");
  t.is(imageGptImage2.inputParameters.output_format, "");
  t.is(imageGptImage2.inputParameters.n, 1);
  t.true("mask" in imageGptImage2.inputParameters);

  for (let i = 0; i < 10; i++) {
    const key = i === 0 ? "input_image" : `input_image_${i + 1}`;
    t.true(key in imageGptImage2.inputParameters, `${key} should be an input parameter`);
  }
});

test("image_gpt_image_2 stringifies object responses for GraphQL result fields", async (t) => {
  const result = await imageGptImage2.executePathway({
    args: {
      text: "a still life",
      quality: "low",
    },
    runAllPrompts: async (args) => ({
      data: [{ b64_json: "abc123" }],
      request: args,
    }),
  });

  t.is(typeof result, "string");
  t.deepEqual(JSON.parse(result), {
    data: [{ b64_json: "abc123" }],
    request: {
      text: "a still life",
      quality: "low",
    },
  });
});

test("media_generate maps GPT Image 2 controls and caps edit inputs at ten images", (t) => {
  const images = Array.from({ length: 12 }, (_, i) => `data:image/png;base64,${i}`);
  const mapped = PARAM_MAPPERS.image_gpt_image_2(
    {
      text: "turn these references into a product render",
      aspectRatio: "16:9",
      imageSize: "2K",
      quality: "high",
      outputFormat: "jpeg",
      numberResults: 3,
    },
    images,
  );

  t.is(mapped.text, "turn these references into a product render");
  t.is(mapped.size, "2560x1440");
  t.is(mapped.quality, "high");
  t.is(mapped.output_format, "jpeg");
  t.is(mapped.n, 3);
  t.is(mapped.input_image, images[0]);
  t.is(mapped.input_image_10, images[9]);
  t.false("input_image_11" in mapped);
});

test("media_generate GPT Image 2 size table satisfies Azure constraints", (t) => {
  const aspectRatios = ["1:1", "16:9", "9:16", "4:3", "3:4"];
  const imageSizes = ["1K", "2K", "4K"];

  for (const aspectRatio of aspectRatios) {
    for (const imageSize of imageSizes) {
      const mapped = PARAM_MAPPERS.image_gpt_image_2({ aspectRatio, imageSize }, []);
      const [width, height] = mapped.size.split("x").map(Number);
      t.is(width % 16, 0, `${mapped.size}: width must be a multiple of 16`);
      t.is(height % 16, 0, `${mapped.size}: height must be a multiple of 16`);
      t.true(Math.max(width, height) < 3840, `${mapped.size}: max edge must be below 3840`);
      t.true(width * height >= 655360, `${mapped.size}: total pixels must meet minimum`);
      t.true(width * height <= 8294400, `${mapped.size}: total pixels must fit maximum`);
      t.true(Math.max(width, height) / Math.min(width, height) <= 3, `${mapped.size}: aspect ratio must fit`);
    }
  }
});

test("media_generate normalizes GPT Image 2 responses through the OpenAI image normalizer", (t) => {
  t.regex(String(mediaGenerate.executePathway), /pathwayName === 'image_gpt_image_2'/);
  t.regex(String(mediaGenerate.executePathway), /normalizeOpenAIImageResponse\(result\)/);
});

test("OPENAI-DALLE3 plugin supports GPT Image 2 generation and edit request contracts", async (t) => {
  const src = await readFile(
    new URL("../../../server/plugins/openAiDallE3Plugin.js", import.meta.url),
    "utf8",
  );

  for (const param of ["size", "quality", "output_format", "background", "n"]) {
    t.regex(src, new RegExp(`['"]${param}['"]`));
  }
  t.regex(src, /prompt\s*:\s*text/);
  t.regex(src, /collectInputImages/);
  t.regex(src, /input_image_\$\{[^}]+\}|input_image_2/);
  t.regex(src, /images\/edits/);
  t.regex(src, /FormData/);
  t.regex(src, /\bmask\b/);
  t.regex(src, /image\[\]/);
  t.true(src.includes("/^data:([^;,]+)[^,]*;base64,(.*)$/"));
});

test("default example exposes GPT Image 2 metadata without service-specific credentials", (t) => {
  const model = configExample.models["oai-gpt-image-2"];

  t.truthy(model);
  t.is(model.type, "OPENAI-DALLE3");
  t.is(model.endpoints[0].headers.Authorization, "Bearer {{OPENAI_API_KEY}}");
  t.false(model.endpoints[0].url.includes("archipelago"));
  t.is(model.metadata.displayName, "GPT Image 2");
  t.is(model.metadata.category, "image");
  t.is(model.metadata.pathwayName, "image_gpt_image_2");
  t.is(model.metadata.resultKey, "image_gpt_image_2");
  t.deepEqual(model.metadata.mediaDefaults.inputImages, [0, 10]);
  t.deepEqual(model.metadata.availableAspectRatios, ["1:1", "16:9", "9:16", "4:3", "3:4"]);
  t.deepEqual(model.metadata.availableImageSizes, ["1K", "2K", "4K"]);
});

test("sys_model_metadata copies GPT Image 2 media fields from config metadata", async (t) => {
  const result = await sysModelMetadata.executePathway({ args: { category: "image" } });
  const parsed = JSON.parse(result);
  const model = parsed.models.find((entry) => entry.modelId === "oai-gpt-image-2");

  t.truthy(model);
  t.is(model.displayName, "GPT Image 2");
  t.is(model.category, "image");
  t.is(model.pathwayName, "image_gpt_image_2");
  t.is(model.resultKey, "image_gpt_image_2");
  t.deepEqual(model.mediaDefaults.inputImages, [0, 10]);
  t.deepEqual(model.availableAspectRatios, ["1:1", "16:9", "9:16", "4:3", "3:4"]);
  t.deepEqual(model.availableImageSizes, ["1K", "2K", "4K"]);
});
