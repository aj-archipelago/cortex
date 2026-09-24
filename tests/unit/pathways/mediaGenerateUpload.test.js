import test from "ava";
import {
    normalizeGeminiResponse,
    normalizeOpenAIImageResponse,
    stripArtifactBinaryData,
} from "../../../pathways/media_generate.js";
import { sanitizePathwayResultDataForProgress } from "../../../server/pathwayResolver.js";

test("stripArtifactBinaryData removes base64 payloads from artifacts", (t) => {
    const resolver = {
        pathwayResultData: {
            artifacts: [
                { type: "image", mimeType: "image/png", data: "AAA", url: "https://example.com/a.png" },
                { type: "audio", mimeType: "audio/mpeg", data: "BBB" },
            ],
        },
    };

    stripArtifactBinaryData(resolver);

    t.deepEqual(resolver.pathwayResultData.artifacts, [
        { type: "image", mimeType: "image/png", url: "https://example.com/a.png" },
        { type: "audio", mimeType: "audio/mpeg" },
    ]);
});

test("normalizeGeminiResponse uploads image artifact and returns HTTPS URL", async (t) => {
    const resolver = {
        pathwayResultData: {
            artifacts: [
                {
                    type: "image",
                    mimeType: "image/png",
                    data: "iVBORw0KGgo=",
                },
            ],
        },
    };
    const uploadCalls = [];
    const uploadFn = async (data, mimeType, _resolver, fileLocation, filename) => {
        uploadCalls.push({ data, mimeType, fileLocation, filename });
        return {
            url: "https://files.example.com/generated.png",
            gcs: "gs://bucket/generated.png",
            hash: "abc123",
        };
    };

    const result = await normalizeGeminiResponse(
        "raw-model-json",
        resolver,
        { text: "A newsroom illustration", contextId: "ctx-1" },
        uploadFn,
    );

    t.is(result, "https://files.example.com/generated.png");
    t.is(uploadCalls.length, 1);
    t.is(uploadCalls[0].data, "iVBORw0KGgo=");
    t.is(uploadCalls[0].mimeType, "image/png");
    t.falsy(resolver.pathwayResultData.artifacts[0].data);
    t.is(
        resolver.pathwayResultData.artifacts[0].url,
        "https://files.example.com/generated.png",
    );
    t.is(resolver.pathwayResultData.artifacts[0].gcs, "gs://bucket/generated.png");
    t.is(resolver.pathwayResultData.artifacts[0].hash, "abc123");
});

test("normalizeGeminiResponse returns raw result when no image artifact data", async (t) => {
    const resolver = {
        pathwayResultData: {
            artifacts: [{ type: "image", url: "https://example.com/x.png" }],
        },
    };
    let uploaded = false;
    const result = await normalizeGeminiResponse(
        "passthrough",
        resolver,
        {},
        async () => {
            uploaded = true;
            return { url: "https://should-not-call" };
        },
    );

    t.is(result, "passthrough");
    t.false(uploaded);
});

test("normalizeOpenAIImageResponse uploads b64_json instead of data URI", async (t) => {
    const raw = JSON.stringify({
        output_format: "jpeg",
        data: [{ b64_json: "/9j/4AAQ" }],
    });
    const uploadCalls = [];
    const result = await normalizeOpenAIImageResponse(
        raw,
        { pathwayResultData: { artifacts: [{ type: "image", data: "legacy" }] } },
        { text: "portrait" },
        async (data, mimeType) => {
            uploadCalls.push({ data, mimeType });
            return { url: "https://files.example.com/portrait.jpg" };
        },
    );

    t.is(result, "https://files.example.com/portrait.jpg");
    t.deepEqual(uploadCalls, [{ data: "/9j/4AAQ", mimeType: "image/jpeg" }]);
});

test("sanitizePathwayResultDataForProgress strips artifact data from info payload", (t) => {
    const sanitized = sanitizePathwayResultDataForProgress({
        model: "gemini-pro-image",
        artifacts: [
            { type: "image", mimeType: "image/png", data: "HUGE", url: "https://x" },
        ],
    });

    t.deepEqual(sanitized, {
        model: "gemini-pro-image",
        artifacts: [{ type: "image", mimeType: "image/png", url: "https://x" }],
    });
});
