import test from "ava";
import fs from "node:fs";
import { PathwayResolver } from "../../../server/pathwayResolver.js";
import CortexRequest from "../../../lib/cortexRequest.js";
import { processPathwayParameters } from "../../../server/typeDef.js";
import mediaGenerate, {
  PARAM_MAPPERS,
} from "../../../pathways/media_generate.js";
import mediaReplicate from "../../../pathways/media_replicate.js";
import { buildPriorityMediaInput } from "../../../server/plugins/replicatePriorityMedia.js";
import { buildMaiImageInput } from "../../../server/plugins/azureMaiImagePlugin.js";
import GeminiInteractionsPlugin from "../../../server/plugins/geminiInteractionsPlugin.js";

const catalog = JSON.parse(
  fs.readFileSync(
    new URL("../../../config/default.example.json", import.meta.url),
  ),
);
const schemas = JSON.parse(
  fs.readFileSync(
    new URL("../../fixtures/september-media-schemas.json", import.meta.url),
  ),
);
const endpoints = Object.fromEntries(
  Object.entries(catalog.models).map(([name, model]) => [
    name,
    { ...model, name, endpoints: model.endpoints || [{ url: model.url }] },
  ]),
);
const config = {
  get: (key) =>
    key === "defaultModelName" ? "replicate-qwen-image-3-pro" : {},
};
const ids = [
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "wan-3",
  "p-video-2-pro",
  "p-video-2",
  "flux-3",
].map((id) => `replicate-${id}`);
const image = "https://example.com/ref.png";
function route(id, settings) {
  const m = catalog.models[id].metadata;
  const args = processPathwayParameters({
    ...mediaGenerate.inputParameters,
    ...m.mediaDefaults,
    model: id,
    text: "Editorial scene",
    inputImages: [],
    inputVideos: [],
    inputAudio: [],
    ...settings,
  });
  const mapped = PARAM_MAPPERS.media_replicate(
    args,
    args.inputImages,
    args.inputVideos,
    args.inputAudio,
  );
  const childArgs = processPathwayParameters({
    ...mediaReplicate.inputParameters,
    ...mapped,
  });
  const resolver = new PathwayResolver({
    config,
    pathway: mediaReplicate,
    args: childArgs,
    endpoints,
  });
  return {
    resolver,
    plugin: resolver.modelExecutor.plugin,
    args: childArgs,
    request: new CortexRequest({ pathwayResolver: resolver }),
  };
}
function check(t, input, schema) {
  for (const key of schema.required) t.true(Object.hasOwn(input, key), key);
  for (const [key, value] of Object.entries(input)) {
    const spec = schema.properties[key];
    t.truthy(spec, key);
    t.is(
      Array.isArray(value)
        ? "array"
        : Number.isInteger(value) && spec.type === "integer"
          ? "integer"
          : typeof value,
      spec.type,
      key,
    );
    if (spec.enum) t.true(spec.enum.includes(value), `${key}=${value}`);
    if (spec.minimum !== undefined) t.true(value >= spec.minimum);
    if (spec.maximum !== undefined) t.true(value <= spec.maximum);
  }
  t.false(Object.hasOwn(input, "openai_api_key"));
  t.false(Object.hasOwn(input, "user_id"));
}
for (const id of ids) {
  test(`${id}: metadata, resolver, provider contract and generated output`, async (t) => {
    const { resolver, plugin, args, request } = route(id);
    t.is(resolver.modelName, id);
    const provider = new URL(request.url).pathname
      .replace(/^\/v1\/models\//, "")
      .replace(/\/predictions$/, "");
    const schema = schemas[provider].Input;
    plugin.executeRequest = async (request) => {
      check(t, request.data.input, schema);
      return plugin.parseResponse({
        status: "succeeded",
        output: id.includes("image")
          ? [image, image + "?second"]
          : "https://example.com/output.mp4",
      });
    };
    const result = await plugin.execute(
      args.text,
      args,
      { prompt: "{{{text}}}" },
      request,
    );
    t.is(result.artifacts.length, id.includes("image") ? 2 : 1);
    const meta = catalog.models[id].metadata;
    const options = {
      aspectRatio: meta.availableAspectRatios,
      duration: meta.availableDurations,
      resolution: meta.availableResolutions,
      outputFormat: meta.availableOutputFormats,
      ...Object.fromEntries(
        (meta.mediaControls || [])
          .filter((c) => c.options)
          .map((c) => [c.key, c.options]),
      ),
    };
    for (const [key, values] of Object.entries(options))
      for (const option of values || []) {
        const { plugin, args } = route(id, { [key]: option?.value ?? option });
        check(
          t,
          plugin.getRequestParameters(args.text, args, { prompt: "{{{text}}}" })
            .input,
          schema,
        );
      }
  });
}
const build = (id, p) => buildPriorityMediaInput(`replicate-${id}`, "Scene", p);
test("new video adapters preserve frame order and reject unsupported media", (t) => {
  const frames = {
    inputImages: [image + "?end", image],
    inputImageRoles: ["end_frame", "start_frame"],
  };
  for (const id of ["p-video-2-pro", "p-video-2"]) {
    const result = build(id, frames);
    t.is(result.image, image);
    t.is(result.last_frame_image, image + "?end");
    t.throws(() =>
      build(id, { inputImages: [image], inputImageRoles: ["end_frame"] }),
    );
    t.throws(() =>
      build(id, { inputVideos: ["https://example.com/input.mp4"] }),
    );
  }
  t.throws(() => build("wan-3", { inputImages: [image, image] }));
  t.throws(() =>
    build("p-video-2-pro", { inputAudio: ["https://example.com/a.mp3"] }),
  );
  t.throws(() => build("p-video-2-pro", { resolution: "1080p" }));
  const audio = build("p-video-2", {
    inputAudio: ["https://example.com/a.mp3"],
    duration: 5,
    generateAudio: false,
  });
  t.false(Object.hasOwn(audio, "duration"));
  t.false(audio.save_audio);
  t.false(audio.disable_safety_filter);
});
test("FLUX storyboard and continuation enforce mutual exclusions and duration", (t) => {
  t.throws(() =>
    build("flux-3", { inputImages: [image], inputVideos: [image] }),
  );
  t.throws(() =>
    build("flux-3", { inputImages: [image, image, image], duration: -1 }),
  );
  t.is(
    build("flux-3", { inputImages: [image, image, image], duration: 20 })
      .duration,
    "20",
  );
  t.is(build("flux-3", { inputVideos: [image] }).start_video, image);
  t.is(
    build("flux-3", { draft: true, resolution: "1080p" }).resolution,
    "720p",
  );
});
test("Image 2.5 handles edits, transparent output and zero compression without direct API credentials", (t) => {
  const input = build("gpt-image-2.5-flare", {
    inputImages: [image],
    numberResults: 3,
    background: "transparent",
    outputFormat: "webp",
    outputCompression: 0,
    openai_api_key: "must-not-forward",
  });
  t.is(input.number_of_images, 3);
  t.deepEqual(input.input_images, [image]);
  t.is(input.output_compression, 0);
  t.false(Object.hasOwn(input, "openai_api_key"));
  t.throws(() =>
    build("gpt-image-2.5-flare", {
      background: "transparent",
      outputFormat: "jpeg",
    }),
  );
  t.throws(() => build("gpt-image-2.5-flare", { numberResults: 11 }));
});
test("Omni GA preserves old IDs and correctly orders start/end frames and extension", (t) => {
  for (const id of [
    "gemini-omni-1.1-flash",
    "gemini-omni-flash-preview",
    "gemini-omni-1.1-flash-preview",
  ]) {
    const plugin = new GeminiInteractionsPlugin(
      { prompt: "{{text}}", name: "test" },
      { ...catalog.models[id], name: id },
    );
    const request = plugin.getRequestParameters(
      "Scene",
      {
        input_images: [image + "?end", image],
        inputImageRoles: ["end_frame", "start_frame"],
        resolution: "4k",
      },
      { prompt: "{{text}}" },
    );
    t.is(request.model, "gemini-omni-1.1-flash");
    t.is(request.input[1].uri, image);
    t.is(request.input[2].uri, image + "?end");
    const extension = plugin.getRequestParameters(
      "Continue",
      { input_video: image, generationMode: "extend" },
      { prompt: "{{text}}" },
    );
    t.is(extension.generation_config.video_config.task, "extend");
    t.throws(() =>
      plugin.getRequestParameters(
        "Continue",
        { generationMode: "extend" },
        { prompt: "{{text}}" },
      ),
    );
  }
});
test("MAI generation limits and edit-only fields follow the Foundry contract", (t) => {
  t.deepEqual(
    buildMaiImageInput("Scene", { size: "1344x768" }, "mai-deployment"),
    {
      model: "mai-deployment",
      prompt: "Scene",
      width: 1344,
      height: 768,
      auto_aspect_ratio: false,
      web_grounding: false,
    },
  );
  t.throws(() =>
    buildMaiImageInput("Scene", { size: "2048x2048" }, "mai-deployment"),
  );
  t.throws(() => PARAM_MAPPERS.image_mai({}, [image, image]));
  t.throws(() => PARAM_MAPPERS.image_mai({}, [], [image]));
  t.false(
    Object.hasOwn(
      buildMaiImageInput(
        "Edit",
        { input_image: image, webGrounding: true },
        "mai-deployment",
      ),
      "width",
    ),
  );
});

test.serial(
  "MAI routes JSON generations and multipart edits through Azure only",
  async (t) => {
    const { default: axios } = await import("axios");
    const { default: pathway } = await import("../../../pathways/image_mai.js");
    const priorEnv = Object.fromEntries(
      [
        "AZURE_MAI_IMAGE_ENDPOINT",
        "AZURE_MAI_IMAGE_KEY",
        "AZURE_MAI_IMAGE_DEPLOYMENT",
      ].map((key) => [key, process.env[key]]),
    );
    const post = axios.post;
    try {
      Object.assign(process.env, {
        AZURE_MAI_IMAGE_ENDPOINT: "https://test.services.ai.azure.com",
        AZURE_MAI_IMAGE_KEY: "fake-test-key",
        AZURE_MAI_IMAGE_DEPLOYMENT: "mai-deployment",
      });
      const resolver = new PathwayResolver({
        config,
        pathway,
        args: {},
        endpoints,
      });
      const plugin = resolver.modelExecutor.plugin;
      const request = new CortexRequest({ pathwayResolver: resolver });
      let calls = 0;
      axios.post = async (url, body, options) => {
        calls++;
        t.is(options.headers["api-key"], "fake-test-key");
        t.true(
          url.startsWith("https://test.services.ai.azure.com/mai/v1/images/"),
        );
        if (url.endsWith("generations")) {
          t.is(body.model, "mai-deployment");
          t.is(body.width, 1024);
        } else {
          const form = body.getBuffer().toString();
          t.regex(form, /name="image"/);
          t.regex(form, /mai-deployment/);
          t.notRegex(form, /name="width"/);
        }
        return { data: { data: [{ b64_json: "image-output" }] } };
      };
      t.is(
        JSON.parse(await plugin.execute("Scene", {}, null, request)).data[0]
          .b64_json,
        "image-output",
      );
      await plugin.execute(
        "Edit",
        { input_image: "data:image/png;base64,aW1hZ2U=", size: "1024x1024" },
        null,
        request,
      );
      t.is(calls, 2);
    } finally {
      axios.post = post;
      for (const [key, value] of Object.entries(priorEnv))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  },
);
