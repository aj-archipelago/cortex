import test from "ava";
import fs from "node:fs";
import { PathwayResolver } from "../../../server/pathwayResolver.js";
import CortexRequest from "../../../lib/cortexRequest.js";
import { processPathwayParameters } from "../../../server/typeDef.js";
import mediaGenerate, { PARAM_MAPPERS, normalizeMediaArtifactResponse, normalizeLyria35Response } from "../../../pathways/media_generate.js";
import mediaReplicate from "../../../pathways/media_replicate.js";
import omni from "../../../pathways/video_gemini_omni.js";
import lyria from "../../../pathways/music_lyria35.js";

const catalog = JSON.parse(fs.readFileSync(new URL("../../../config/default.example.json", import.meta.url)));
// Public provider contracts captured during the integration audit, with version IDs.
const schemas = JSON.parse(fs.readFileSync(new URL("../../fixtures/priority-replicate-schemas.json", import.meta.url)));
const definitions = { media_replicate: mediaReplicate, video_gemini_omni: omni, music_lyria35: lyria };
const endpoints = Object.fromEntries(Object.entries(catalog.models).map(([name, model]) => [name, {
    ...model, name, endpoints: model.endpoints || [{ url: model.url }],
}]));
const config = { get: key => key === "defaultModelName" ? "replicate-qwen-image-3-pro" : {} };
const image = "https://example.com/reference.png";
const cases = [
    ["replicate-seedance-2.5", {}, "https://example.com/video.mp4"],
    ["replicate-ltx-2.5-fast", {}, "https://example.com/video.mp4"],
    ["replicate-qwen-image-3-pro", {}, "https://example.com/image.png"],
    ["replicate-seedream-5-pro", {}, ["https://example.com/base.png", "https://example.com/layer.png"]],
    ["replicate-recraft-v4-styles-pro", { styleId: "style-123" }, { image: "https://example.com/image.png", style_id: "style-123" }],
    ["replicate-recraft-v4-styles-pro-svg", { inputImages: [image] }, { image: "https://example.com/image.svg", style_id: "style-456" }],
    ["replicate-elevenlabs-dubbing", { sourceUrl: "https://example.com/source.mp4", targetLanguage: "ar" }, "https://example.com/dub.flac"],
];

function route(id, overrides = {}) {
    const metadata = catalog.models[id].metadata;
    const defaults = metadata.mediaDefaults || {};
    const args = processPathwayParameters({ ...mediaGenerate.inputParameters,
        model: id, text: "Editorial scene", ...defaults,
        imageSize: defaults.image_size, inputImages: [], inputVideos: [], inputAudio: [], ...overrides,
    });
    const mapped = PARAM_MAPPERS[metadata.pathwayName](args, args.inputImages, args.inputVideos, args.inputAudio);
    const pathway = definitions[metadata.pathwayName];
    const childArgs = processPathwayParameters({ ...pathway.inputParameters, ...mapped });
    const resolver = new PathwayResolver({ config, pathway, args: childArgs, endpoints });
    const plugin = resolver.modelExecutor.plugin;
    const request = new CortexRequest({ pathwayResolver: resolver });
    return { resolver, plugin, request, args: childArgs };
}

function assertSchema(t, input, schema) {
    for (const field of schema.required || []) t.true(Object.hasOwn(input, field), field);
    for (const [field, value] of Object.entries(input)) {
        const spec = schema.properties[field];
        t.truthy(spec, `unknown provider field: ${field}`);
        if (!spec) continue;
        if (spec.enum) t.true(spec.enum.includes(value), `${field}: ${value}`);
        if (spec.type === "array") t.true(Array.isArray(value), field);
        else if (spec.type === "integer") t.true(Number.isInteger(value), field);
        else t.is(typeof value, spec.type, field);
        if (spec.minimum !== undefined) t.true(value >= spec.minimum, field);
        if (spec.maximum !== undefined) t.true(value <= spec.maximum, field);
        if (spec.maxLength !== undefined) t.true(value.length <= spec.maxLength, field);
    }
}

for (const [id, settings, output] of cases) {
    test(`${id}: metadata -> mapper -> real resolver -> endpoint -> provider payload -> response`, async t => {
        const { resolver, plugin, request, args } = route(id, settings);
        t.is(resolver.modelName, id);
        t.is(plugin.modelName, id);
        t.is(request.url, catalog.models[id].url);
        const provider = new URL(request.url).pathname.replace(/^\/v1\/models\//, "").replace(/\/predictions$/, "");
        // Stub only the outbound HTTP boundary. Routing, parameter conversion,
        // provider validation, execute and response parsing are the real code.
        let calls = 0;
        plugin.executeRequest = async outgoing => {
            calls++;
            t.is(outgoing.url, catalog.models[id].url);
            assertSchema(t, outgoing.data.input, schemas[provider].Input);
            return plugin.parseResponse({ status: "succeeded", output });
        };
        const result = await plugin.execute(args.text, args, { prompt: "{{{text}}}" }, request);
        t.is(calls, 1);
        t.deepEqual(JSON.parse(result.output_text).output, output);
        t.true(result.artifacts.length > 0);
    });
}

test("Seedream match_input_image stays Seedream, including every advertised ratio", t => {
    for (const aspectRatio of catalog.models["replicate-seedream-5-pro"].metadata.availableAspectRatios) {
        const { plugin, args } = route("replicate-seedream-5-pro", { aspectRatio });
        const input = plugin.getRequestParameters(args.text, args, { prompt: "{{{text}}}" }).input;
        t.is(input.aspect_ratio, aspectRatio);
        t.false(Object.hasOwn(input, "match_input_image"));
    }
});

test("a mismatched shared-pathway model fails explicitly instead of submitting to another model", t => {
    const { plugin, args } = route("replicate-qwen-image-3-pro");
    t.throws(() => plugin.getRequestParameters(args.text, { ...args, model: "replicate-seedream-5-pro", aspectRatio: "match_input_image" }, { prompt: "{{{text}}}" }), { message: /does not match resolved model/ });
});

for (const [id, settings] of cases) {
    test(`${id}: every advertised option builds a provider-valid request`, t => {
        const metadata = catalog.models[id].metadata;
        const lists = {
            aspectRatio: metadata.availableAspectRatios,
            imageSize: metadata.availableImageSizes,
            duration: metadata.availableDurations,
            resolution: metadata.availableResolutions,
            outputFormat: metadata.availableOutputFormats,
            ...Object.fromEntries((metadata.mediaControls || []).filter(control => control.options).map(control => [control.key, control.options.map(option => option.value)])),
        };
        // Modes needing references are exercised with minimal valid inputs.
        for (const [key, values] of Object.entries(lists)) {
            for (const value of values || []) {
                const overrides = { ...settings, [key]: value };
                if (id === "replicate-seedream-5-pro" && ["1.5K", "auto"].includes(value)) Object.assign(overrides, { layerDecomposition: true, inputImages: [image] });
                if (key === "generationMode" && value !== "generate") overrides.inputVideos = ["https://example.com/source.mp4"];
                const { plugin, args, request } = route(id, overrides);
                const input = plugin.getRequestParameters(args.text, args, { prompt: "{{{text}}}" }).input;
                const provider = new URL(request.url).pathname.replace(/^\/v1\/models\//, "").replace(/\/predictions$/, "");
                assertSchema(t, input, schemas[provider].Input);
            }
        }
    });
}

test("Omni 1.1 uses its own model, reference limits and output settings; legacy fallback remains", t => {
    const id = "gemini-omni-1.1-flash-preview";
    const { resolver, plugin, request, args } = route(id, {
        inputImages: Array.from({ length: 10 }, (_, i) => `https://example.com/${i}.png`),
        resolution: "4k", aspectRatio: "9:16",
    });
    t.is(resolver.modelName, id);
    t.is(request.url, catalog.models[id].endpoints[0].url);
    const input = plugin.getRequestParameters(args.text, args, { prompt: "{{{text}}}" });
    t.is(input.model, "gemini-omni-1.1-flash");
    t.is(input.input.length, 11);
    t.deepEqual(input.response_format, { type: "video", aspect_ratio: "9:16", resolution: "4k" });
    const fallback = new PathwayResolver({ config, pathway: omni, args: {}, endpoints });
    t.is(fallback.modelName, "gemini-omni-1.1-flash");
});

test("Lyria 3.5 retains its dedicated endpoint and requested WAV format through routing", t => {
    const { resolver, plugin, request, args } = route("google-lyria-3.5-music", { audioFormat: "wav", inputImages: [image] });
    t.is(resolver.modelName, "google-lyria-3.5-music");
    t.is(new URL(request.url).hostname, "generativelanguage.googleapis.com");
    const input = plugin.getRequestParameters(args.text, args, { prompt: "{{{text}}}" });
    t.is(input.model, "lyria-3.5");
    t.deepEqual(input.response_format, { type: "audio" });
    t.is(input.input.length, 2);
});

test("H3 remains blocked on the direct shared route instead of falling back to Qwen", t => {
    const { resolver, plugin, args } = route("replicate-minimax-h3");
    t.is(resolver.modelName, "replicate-minimax-h3");
    t.throws(() => plugin.getRequestParameters(args.text, args, { prompt: "{{{text}}}" }), { message: /published Replicate API schema/ });
});

test("omitted audio toggle does not override provider defaults; explicit false is preserved", t => {
    const omitted = processPathwayParameters(mediaGenerate.inputParameters);
    t.is(omitted.generateAudio, undefined);
    for (const id of ["replicate-seedance-2.5", "replicate-ltx-2.5-fast"]) {
        for (const generateAudio of [undefined, false, true]) {
            const { plugin, args } = route(id, { generateAudio });
            const input = plugin.getRequestParameters(args.text, args, { prompt: "{{{text}}}" }).input;
            t.is(input.generate_audio, generateAudio ?? true);
        }
    }
});

test("Omni uploads all inline video outputs before progress and preserves URL outputs", async t => {
    const resolver = { pathwayResultData: { artifacts: [
        { type: "video", data: "video-one", mimeType: "video/mp4" },
        { type: "video", data: "video-two", mimeType: "video/mp4" },
        { type: "video", url: "https://example.com/third.mp4", mimeType: "video/mp4" },
    ] } };
    const filenames = [];
    const result = await normalizeMediaArtifactResponse("", resolver, "video", "video/mp4", { text: "Scene" }, async (data, mime, context, location, filename) => {
        filenames.push(filename);
        return { url: `https://example.com/${filename}` };
    });
    const output = JSON.parse(result).output;
    t.is(output.length, 3);
    t.is(new Set(filenames).size, 2);
    t.false(JSON.stringify(resolver).includes('"data":'));
    t.false(result.includes("base64"));
});

test("Lyria multi-part audio uploads use distinct filenames and retain lyrics", async t => {
    const resolver = { pathwayResultData: { artifacts: [
        { type: "audio", data: "one", mimeType: "audio/wav" },
        { type: "audio", data: "two", mimeType: "audio/wav" },
    ] } };
    const result = JSON.parse(await normalizeLyria35Response("Lyrics", resolver, { text: "Song" }, async (data, mime, context, location, filename) => ({ url: `https://example.com/${filename}` })));
    t.is(new Set(result.output.map(item => item.url)).size, 2);
    t.is(result.lyrics, "Lyrics");
});
