// sys_model_metadata.test.js
import test from "ava";
import { config } from "../../../config.js";
import serverFactory from "../../../index.js";
import { buildASTSchema, concatAST, parse } from "graphql";

let testServer;
let testSchema;

test.before(async () => {
    const { server, typeDefs } = await serverFactory();
    const definitions = Array.isArray(typeDefs) ? typeDefs : [typeDefs];
    testSchema = buildASTSchema(concatAST(definitions.map(definition => typeof definition === "string" ? parse(definition) : definition)));
    await server.start();
    testServer = server;
});

test.after.always("cleanup", async () => {
    if (testServer) {
        await testServer.stop();
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
});

async function queryMetadata(variables = {}) {
    const response = await testServer.executeOperation({
        query: `query SysModelMetadata($category: String) {
            sys_model_metadata(category: $category) { result }
        }`,
        variables,
    });
    const errors = response.body?.singleResult?.errors;
    const resultStr =
        response.body?.singleResult?.data?.sys_model_metadata?.result;
    return { errors, data: resultStr ? JSON.parse(resultStr) : null };
}

// Sensitive fields that must never appear in the response
test("media GraphQL schema declares every priority control and reference array", t => {
    const fields = testSchema.getQueryType().getFields();
    for (const pathway of ["media_generate", "media_replicate"]) {
        const args = fields[pathway].args;
        for (const [key,type] of Object.entries({fps:"Int",generationMode:"String",watermark:"Boolean",matchInputImage:"Boolean",enablePromptExpansion:"Boolean",layerDecomposition:"Boolean",styleId:"String",styleMatch:"String",sourceUrl:"String",sourceLanguage:"String",targetLanguage:"String",cloningStrength:"Int"})) {
            t.is(args.find(arg => arg.name === key)?.type.name,type,`${pathway}.${key}`);
        }
        t.is(String(args.find(arg => arg.name === "inputAudio").type),"[String]");
    }
});

test("priority media metadata exposes complete contracts and gates unavailable models", async t => {
    const { errors, data } = await queryMetadata();
    t.is(errors, undefined);
    const find = id => data.models.find(model => model.modelId === id);
    for (const id of ["replicate-seedance-2.5", "replicate-ltx-2.5-fast", "replicate-qwen-image-3-pro", "replicate-seedream-5-pro", "replicate-recraft-v4-styles-pro", "replicate-recraft-v4-styles-pro-svg", "replicate-elevenlabs-dubbing"]) {
        const model = find(id);
        t.truthy(model, id);
        t.is(model.pathwayName, "media_replicate");
        t.is(model.provider, "replicate");
        t.is(model.requiredEnv, "REPLICATE_API_KEY");
        t.truthy(model.mediaControls?.length);
    }
    t.deepEqual(find("replicate-seedance-2.5").mediaDefaults.inputAudio, [0,10]);
    t.deepEqual(find("replicate-seedance-2.5").availableResolutions, ["480p","720p"]);
    t.false(find("replicate-minimax-h3").isAvailable);
    t.regex(find("replicate-minimax-h3").unavailableReason, /published Replicate API schema/);
    t.is(find("google-lyria-3.5-music").requiredEnv, "GEMINI_API_KEY");
    t.is(find("google-lyria-3.5-music").releaseStage, undefined);
    t.deepEqual(find("gemini-omni-1.1-flash-preview").availableDurations, []);
    t.deepEqual(find("gemini-omni-1.1-flash-preview").mediaDefaults.inputAudio, [0,0]);
    t.is(find("gemini-flash-38-vision").releaseStage, "ga");
    t.true(find("gemini-flash-38-vision").isAgentic);
});

const SENSITIVE_FIELDS = [
    "endpoints",
    "headers",
    "url",
    "params",
    "requestsPerSecond",
    "restStreaming",
    "reasoningEffortMap",
    "budgetTokensMap",
];

test("conditional media option contracts survive the metadata API", async t => {
    const { errors, data } = await queryMetadata();
    t.is(errors, undefined);
    const seedream = data.models.find(model => model.modelId === "replicate-seedream-5-pro");
    t.deepEqual(seedream.mediaDefaultOverrides.find(rule => rule.when.layerDecomposition === false).mediaOptions, { image_size: ["1K", "2K"] });
    t.deepEqual(seedream.mediaDefaultOverrides.find(rule => rule.when.layerDecomposition === true).mediaOptions, { image_size: ["1K", "1.5K", "2K", "auto"] });
    const ltx = data.models.find(model => model.modelId === "replicate-ltx-2.5-fast");
    t.deepEqual(ltx.mediaDefaultOverrides, [{ when: { duration: [12, 14, 16, 18, 20] }, mediaOptions: { resolution: ["720p", "1080p"], fps: [24, 25] } }]);
});

test("priority prompt and visual modes preserve text-only and mixed-reference UI paths", async t => {
    const { data } = await queryMetadata();
    for (const id of ["replicate-seedance-2.5", "gemini-omni-1.1-flash-preview", "google-lyria-3.5-music"]) {
        const model = data.models.find(entry => entry.modelId === id);
        const promptMode = model.mediaInputModes.find(mode => mode.key === "prompt");
        t.true(promptMode.promptRequired, id);
        t.deepEqual(promptMode.requiresAnyOf, [{ prompt: true }]);
        for (const range of Object.values(promptMode.requires)) t.is(range[0], 0);
        for (const mode of model.mediaInputModes) {
            for (const key of ["inputImages", "inputVideos", "inputAudio"]) {
                const ceiling = model.mediaDefaults[key]?.[1] || 0;
                if (ceiling) t.is(mode.requires[key]?.[1], ceiling, `${id}.${mode.key}.${key}`);
            }
        }
    }
});

test("returns non-empty model array with required fields", async (t) => {
    const { errors, data } = await queryMetadata();
    t.is(errors, undefined);
    t.truthy(data);
    t.true(Array.isArray(data.models));
    t.true(data.models.length > 0);

    for (const model of data.models) {
        t.truthy(model.modelId, "model should have modelId");
        t.truthy(model.displayName, "model should have displayName");
        t.truthy(model.category, "model should have category");
        t.true(
            ["chat", "image", "video", "audio", "tts", "upscaling", "embedding"].includes(
                model.category,
            ),
            `category should be chat/image/video/audio/tts/upscaling, got: ${model.category}`,
        );
    }
});

test("category filter works", async (t) => {
    const { errors: chatErrors, data: chatData } = await queryMetadata({
        category: "chat",
    });
    t.is(chatErrors, undefined);
    t.true(chatData.models.length > 0);
    for (const model of chatData.models) {
        t.is(model.category, "chat");
    }

    const { errors: imageErrors, data: imageData } = await queryMetadata({
        category: "image",
    });
    t.is(imageErrors, undefined);
    t.true(imageData.models.length > 0);
    for (const model of imageData.models) {
        t.is(model.category, "image");
    }

    const { errors: videoErrors, data: videoData } = await queryMetadata({
        category: "video",
    });
    t.is(videoErrors, undefined);
    t.true(videoData.models.length > 0);
    for (const model of videoData.models) {
        t.is(model.category, "video");
    }

    const { errors: ttsErrors, data: ttsData } = await queryMetadata({
        category: "tts",
    });
    t.is(ttsErrors, undefined);
    t.true(ttsData.models.length > 0);
    for (const model of ttsData.models) {
        t.is(model.category, "tts");
    }

    const { errors: upscalingErrors, data: upscalingData } =
        await queryMetadata({
            category: "upscaling",
        });
    t.is(upscalingErrors, undefined);
    t.true(upscalingData.models.length > 0);
    for (const model of upscalingData.models) {
        t.is(model.category, "upscaling");
    }
});

test("no sensitive fields in response", async (t) => {
    const { data } = await queryMetadata();

    for (const model of data.models) {
        for (const field of SENSITIVE_FIELDS) {
            t.is(
                model[field],
                undefined,
                `model ${model.modelId} should not have sensitive field '${field}'`,
            );
        }
    }
});

test("redirects map is present", async (t) => {
    const { data } = await queryMetadata();
    t.truthy(data.redirects);
    t.is(typeof data.redirects, "object");
    // Should have at least the known redirects
    t.is(data.redirects["claude-3-haiku-vertex"], "claude-45-haiku-vertex");
    t.is(data.redirects["claude-35-haiku-vertex"], "claude-45-haiku-vertex");
    t.is(data.redirects["claude-35-sonnet-vertex"], "claude-5-sonnet-vertex");
    t.is(data.redirects["claude-37-sonnet-vertex"], "claude-5-sonnet-vertex");
    t.is(data.redirects["claude-4-sonnet-vertex"], "claude-5-sonnet-vertex");
    t.is(data.redirects["claude-45-sonnet-vertex"], "claude-5-sonnet-vertex");
    t.is(data.redirects["claude-46-sonnet-vertex"], "claude-5-sonnet-vertex");
    t.is(data.redirects["claude-3-opus-vertex"], "claude-48-opus-vertex");
    t.is(data.redirects["claude-41-opus-vertex"], "claude-48-opus-vertex");
    t.is(data.redirects["claude-45-opus-vertex"], "claude-48-opus-vertex");
    t.is(data.redirects["claude-46-opus-vertex"], "claude-48-opus-vertex");
    t.is(data.redirects["claude-47-opus-vertex"], "claude-48-opus-vertex");
    t.is(data.redirects["gemini-flash-3-vision"], "gemini-flash-37-vision");
    t.is(
        data.redirects["gemini-flash-lite-31-vision"],
        "gemini-flash-lite-35-vision",
    );
});

test("redirected models are hidden from metadata listings", async (t) => {
    const { data } = await queryMetadata({ category: "chat" });
    const modelIds = data.models.map((m) => m.modelId);

    t.true(modelIds.includes("claude-45-haiku-vertex"));
    t.true(modelIds.includes("claude-5-sonnet-vertex"));
    t.true(modelIds.includes("claude-48-opus-vertex"));
    t.true(modelIds.includes("gemini-flash-36-vision"));
    t.true(modelIds.includes("gemini-flash-37-vision"));
    t.true(modelIds.includes("gemini-flash-35-vision"));
    t.true(modelIds.includes("gemini-flash-lite-35-vision"));
    t.false(modelIds.includes("claude-37-sonnet-vertex"));
    t.false(modelIds.includes("claude-4-sonnet-vertex"));
    t.false(modelIds.includes("claude-45-sonnet-vertex"));
    t.false(modelIds.includes("claude-46-sonnet-vertex"));
    t.false(modelIds.includes("claude-46-opus-vertex"));
    t.false(modelIds.includes("claude-47-opus-vertex"));
    t.false(modelIds.includes("gemini-flash-3-vision"));
    t.false(modelIds.includes("gemini-flash-lite-31-vision"));
});

test("current Gemini Flash models expose chat metadata", async (t) => {
    const { data } = await queryMetadata({ category: "chat" });
    const expectedModels = [
        ["gemini-flash-35-vision", "Gemini 3.5 Flash", "gemini-flash-35"],
        ["gemini-flash-36-vision", "Gemini 3.6 Flash", "gemini-flash-36"],
        ["gemini-flash-37-vision", "Gemini 3.7 Flash", "gemini-flash-37"],
        [
            "gemini-flash-lite-35-vision",
            "Gemini 3.5 Flash Lite",
            "gemini-flash-lite-35",
        ],
    ];

    for (const [modelId, displayName, providerModel] of expectedModels) {
        const model = data.models.find((item) => item.modelId === modelId);

        t.truthy(model);
        t.is(model.displayName, displayName);
        t.is(model.provider, "google");
        t.is(model.type, "GEMINI-3-REASONING-VISION");
        t.is(model.emulateOpenAIChatModel, providerModel);
        t.is(model.maxTokenLength, 1048576);
        t.is(model.maxReturnTokens, 65535);
        t.true(model.supportsStreaming);
        t.true(model.isAgentic);
    }
});

test("Claude Sonnet 5 Vertex metadata exposes limits without operator pricing", async (t) => {
    const { data } = await queryMetadata({ category: "chat" });
    const model = data.models.find((m) => m.modelId === "claude-5-sonnet-vertex");

    t.truthy(model);
    t.is(model.displayName, "Claude 5 Sonnet");
    t.is(model.provider, "anthropic");
    t.is(model.type, "CLAUDE-4-VERTEX");
    t.is(model.emulateOpenAIChatModel, "claude-sonnet-5");
    t.is(model.maxTokenLength, 1000000);
    t.is(model.maxReturnTokens, 128000);
    t.is(model.pricing, undefined);
});

test("Claude Opus 4.8 Vertex metadata exposes limits without operator pricing", async (t) => {
    const { data } = await queryMetadata({ category: "chat" });
    const model = data.models.find((m) => m.modelId === "claude-48-opus-vertex");

    t.truthy(model);
    t.is(model.displayName, "Claude 4.8 Opus");
    t.is(model.provider, "anthropic");
    t.is(model.type, "CLAUDE-4-VERTEX");
    t.is(model.emulateOpenAIChatModel, "claude-opus-4-8");
    t.is(model.maxTokenLength, 1000000);
    t.is(model.maxReturnTokens, 128000);
    t.is(model.pricing, undefined);
});

test("public provider model names do not carry deployment aliases", async (t) => {
    const { data } = await queryMetadata({ category: "chat" });
    const model = data.models.find((m) => m.modelId === "oai-gpt55");

    t.truthy(model);
    t.is(model.pricingAliases, undefined);
    t.is(model.emulateOpenAIChatModel, "gpt-5.5");
    t.is(model.endpoints, undefined);
    t.is(model.params, undefined);
});

test("GPT 5.6 models expose chat metadata without operator pricing", async (t) => {
    const { data } = await queryMetadata({ category: "chat" });
    const expectedModels = [
        ["oai-gpt56-luna", "GPT 5.6 Luna", "gpt-5.6-luna"],
        ["oai-gpt56-terra", "GPT 5.6 Terra", "gpt-5.6-terra"],
        ["oai-gpt56-sol", "GPT 5.6 Sol", "gpt-5.6-sol"],
    ];

    for (const [modelId, displayName, providerModel] of expectedModels) {
        const model = data.models.find((m) => m.modelId === modelId);

        t.truthy(model);
        t.is(model.displayName, displayName);
        t.is(model.provider, "openai");
        t.is(model.type, "OPENAI-RESPONSES");
        t.is(model.emulateOpenAIChatModel, providerModel);
        t.is(model.maxTokenLength, 1050000);
        t.is(model.maxReturnTokens, 128000);
        t.true(model.supportsStreaming);
        t.true(model.isAgentic);
        t.is(model.pricing, undefined);
        t.is(model.pricingAliases, undefined);
        t.is(model.endpoints, undefined);
        t.is(model.params, undefined);
    }
});

test("GPT 6 Astra exposes chat metadata without operator pricing", async (t) => {
    const { data } = await queryMetadata({ category: "chat" });
    const model = data.models.find(
        (candidate) => candidate.modelId === "oai-gpt6-astra",
    );

    t.truthy(model);
    t.is(model.displayName, "GPT 6 Astra");
    t.is(model.provider, "openai");
    t.is(model.type, "OPENAI-RESPONSES");
    t.is(model.emulateOpenAIChatModel, "gpt-6-astra");
    t.is(model.maxTokenLength, 1050000);
    t.is(model.maxReturnTokens, 128000);
    t.true(model.supportsStreaming);
    t.true(model.isAgentic);
    t.deepEqual(model.supportedReasoningEfforts, [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ]);
    t.is(model.pricing, undefined);
    t.is(model.endpoints, undefined);
    t.is(model.params, undefined);
});

test("Codex auto-review is not exposed as a chat model", async (t) => {
    const { data } = await queryMetadata({ category: "chat" });
    const model = data.models.find(
        (candidate) => candidate.modelId === "oai-codex-auto-review",
    );

    t.is(model, undefined);
});

test("agentic models are flagged", async (t) => {
    const { data } = await queryMetadata({ category: "chat" });
    const agenticModels = data.models.filter((m) => m.isAgentic);
    t.true(
        agenticModels.length >= 8,
        `expected at least 8 agentic models, got ${agenticModels.length}`,
    );

    // Verify known agentic models
    const agenticIds = agenticModels.map((m) => m.modelId);
    t.true(agenticIds.includes("oai-gpt56-terra"));
    t.true(agenticIds.includes("oai-gpt55"));
    t.true(agenticIds.includes("claude-48-opus-vertex"));
    t.true(agenticIds.includes("claude-5-sonnet-vertex"));
    t.true(agenticIds.includes("gemini-flash-36-vision"));
    t.true(agenticIds.includes("gemini-flash-37-vision"));
    t.true(agenticIds.includes("gemini-flash-35-vision"));
    t.true(agenticIds.includes("gemini-flash-lite-35-vision"));
    t.true(agenticIds.includes("xai-grok-4-3"));
    t.true(agenticIds.includes("xai-grok-4-20-reasoning"));
    t.false(agenticIds.includes("gemini-flash-3-vision"));
    t.false(agenticIds.includes("gemini-flash-lite-31-vision"));
    t.false(agenticIds.includes("xai-grok-4-20-non-reasoning"));
    t.false(agenticIds.includes("xai-grok-4-1-fast-reasoning"));
    t.false(agenticIds.includes("xai-grok-4-1-fast-non-reasoning"));
    t.false(agenticIds.includes("xai-grok-4-20-multi-agent"));
    t.false(agenticIds.includes("xai-grok-4-20-responses"));
});

test("chat metadata exposes GPT 5.6 Terra as the default and the supported Grok chat set", async (t) => {
    const { data } = await queryMetadata({ category: "chat" });

    const defaultModels = data.models.filter((m) => m.isDefault);
    t.deepEqual(
        defaultModels.map((m) => m.modelId),
        ["oai-gpt56-terra"],
    );

    const chatIds = data.models.map((m) => m.modelId);
    t.true(chatIds.includes("xai-grok-4-3"));
    t.true(chatIds.includes("xai-grok-4-20-reasoning"));
    t.true(chatIds.includes("xai-grok-4-20-non-reasoning"));
    t.true(chatIds.includes("xai-grok-4-20-multi-agent"));
    t.true(chatIds.includes("xai-grok-4-1-fast-reasoning"));
    t.true(chatIds.includes("xai-grok-4-1-fast-non-reasoning"));
    t.false(chatIds.includes("oai-gpt54"));
    t.false(chatIds.includes("xai-grok-4-20-responses"));
});

test("regular GPT 5.4 is retired through the Terra redirect", async (t) => {
    const { data } = await queryMetadata({ category: "chat" });

    const chatIds = data.models.map((m) => m.modelId);
    t.false(chatIds.includes("oai-gpt54"));
    t.true(chatIds.includes("oai-gpt54-mini"));
    t.is(data.redirects["oai-gpt54"], "oai-gpt56-terra");
});

test("public metadata does not invent an operator model group", async (t) => {
    const { data } = await queryMetadata({ category: "chat" });
    t.false(data.models.some(model => model.isModelGroup));
});

test("gpt-chat-latest exposes medium-only reasoning metadata without exposing the raw map", async (t) => {
    const { data } = await queryMetadata({ category: "chat" });
    const model = data.models.find((m) => m.modelId === "oai-gpt-chat-latest");

    t.truthy(model);
    t.is(model.displayName, "GPT 5.5 Instant");
    t.deepEqual(model.supportedReasoningEfforts, ["medium"]);
    t.is(model.reasoningEffortMap, undefined);
});

test("media models have required fields", async (t) => {
    const { data: imageData } = await queryMetadata({ category: "image" });
    for (const model of imageData.models) {
        t.truthy(
            model.pathwayName,
            `image model ${model.modelId} should have pathwayName`,
        );
        t.truthy(
            model.resultKey,
            `image model ${model.modelId} should have resultKey`,
        );
        t.truthy(
            model.mediaDefaults,
            `image model ${model.modelId} should have mediaDefaults`,
        );
        t.true(
            Array.isArray(model.availableAspectRatios),
            `image model ${model.modelId} should have availableAspectRatios array`,
        );
    }

    const { data: videoData } = await queryMetadata({ category: "video" });
    for (const model of videoData.models) {
        t.truthy(
            model.pathwayName,
            `video model ${model.modelId} should have pathwayName`,
        );
        t.truthy(
            model.resultKey,
            `video model ${model.modelId} should have resultKey`,
        );
        t.truthy(
            model.mediaDefaults,
            `video model ${model.modelId} should have mediaDefaults`,
        );
        t.true(
            Array.isArray(model.availableAspectRatios),
            `video model ${model.modelId} should have availableAspectRatios array`,
        );
        t.true(
            Array.isArray(model.availableDurations),
            `video model ${model.modelId} should have availableDurations array`,
        );
    }

    const { data: upscalingData } = await queryMetadata({
        category: "upscaling",
    });
    for (const model of upscalingData.models) {
        t.truthy(
            model.pathwayName,
            `upscaling model ${model.modelId} should have pathwayName`,
        );
        t.truthy(
            model.resultKey,
            `upscaling model ${model.modelId} should have resultKey`,
        );
        t.truthy(
            model.mediaDefaults,
            `upscaling model ${model.modelId} should have mediaDefaults`,
        );
        t.true(
            Array.isArray(model.mediaDefaults.inputImages) ||
                Array.isArray(model.mediaDefaults.inputVideos),
            `upscaling model ${model.modelId} should expose input image or video support`,
        );
        t.true(
            Array.isArray(model.mediaControls),
            `upscaling model ${model.modelId} should expose schema-backed controls`,
        );
    }

    const { data: audioData } = await queryMetadata({ category: "audio" });
    for (const model of audioData.models) {
        t.truthy(
            model.pathwayName,
            `audio model ${model.modelId} should have pathwayName`,
        );
        t.truthy(
            model.resultKey,
            `audio model ${model.modelId} should have resultKey`,
        );
        t.truthy(
            model.mediaDefaults,
            `audio model ${model.modelId} should have mediaDefaults`,
        );
        t.true(
            Array.isArray(model.mediaDefaults.inputImages),
            `audio model ${model.modelId} should expose input image support`,
        );
        if (model.modelId.startsWith("google-lyria")) {
            t.is(
                model.availableDurations,
                undefined,
                `audio model ${model.modelId} should not expose fake duration settings`,
            );
        } else if (model.availableDurations !== undefined) {
            t.true(
                Array.isArray(model.availableDurations),
                `audio model ${model.modelId} should expose real duration options as an array`,
            );
        }
        t.is(
            model.availableAudioStyles,
            undefined,
            `audio model ${model.modelId} should not expose fake style settings`,
        );
        t.is(
            model.availableAudioMoods,
            undefined,
            `audio model ${model.modelId} should not expose fake mood settings`,
        );
        t.is(
            model.availableAudioUseCases,
            undefined,
            `audio model ${model.modelId} should not expose fake use-case settings`,
        );
    }
});

test("audio metadata capability-gates Lyria when Vertex service account is missing", async (t) => {
    const { data } = await queryMetadata({ category: "audio" });
    const clip = data.models.find((m) => m.modelId === "google-lyria-3-music");
    const pro = data.models.find(
        (m) => m.modelId === "google-lyria-3-pro-music",
    );

    t.truthy(clip);
    t.truthy(pro);
    t.is(clip.displayName, "Lyria 3 Clip");
    t.is(pro.displayName, "Lyria 3 Pro");
    t.deepEqual(clip.mediaDefaults, {
        inputImages: [0, 1],
    });
    t.deepEqual(pro.mediaDefaults, {
        inputImages: [0, 1],
    });
    t.is(clip.preferredUrlFormat, "gcs");
    t.is(pro.preferredUrlFormat, "gcs");
    t.deepEqual(clip.requiredEnv, ["GCP_SERVICE_ACCOUNT_KEY", "GCP_PROJECT_ID"]);
    t.deepEqual(pro.requiredEnv, ["GCP_SERVICE_ACCOUNT_KEY", "GCP_PROJECT_ID"]);
});

test("replicate ElevenLabs Music is exposed with API-backed audio controls", async (t) => {
    const { data } = await queryMetadata({ category: "audio" });
    const model = data.models.find(
        (m) => m.modelId === "replicate-elevenlabs-music",
    );

    t.truthy(model);
    t.is(model.displayName, "ElevenLabs Music");
    t.is(model.provider, "replicate");
    t.is(model.pathwayName, "music_replicate");
    t.is(model.resultKey, "music_replicate");
    t.deepEqual(model.mediaDefaults, {
        inputImages: [0, 0],
        duration: 10,
        outputFormat: "wav_cd_quality",
        forceInstrumental: true,
    });
    t.is(model.availableDurations, undefined);
    t.deepEqual(
        model.mediaControls.find((control) => control.key === "duration"),
        {
            key: "duration",
            label: "Duration",
            type: "integer",
            min: 5,
            max: 300,
            step: 1,
            unit: "s",
            defaultValue: 10,
        },
    );
    t.true(
        model.availableOutputFormats.some(
            (format) => format.value === "wav_cd_quality",
        ),
    );
    t.true(model.mediaToggles.includes("forceInstrumental"));
    t.is(model.requiredEnv, "REPLICATE_API_KEY");
});

test("replicate MiniMax music models expose schema-backed media controls", async (t) => {
    const { data } = await queryMetadata({ category: "audio" });
    const music = data.models.find(
        (m) => m.modelId === "replicate-minimax-music-26",
    );
    const cover = data.models.find(
        (m) => m.modelId === "replicate-minimax-music-cover",
    );

    t.truthy(music);
    t.truthy(cover);
    t.is(music.pathwayName, "music_replicate");
    t.is(cover.pathwayName, "music_replicate");
    t.deepEqual(music.mediaDefaults, {
        inputImages: [0, 0],
        audioFormat: "wav",
        sampleRate: 44100,
        bitrate: 256000,
        isInstrumental: true,
        lyricsOptimizer: false,
    });
    t.deepEqual(cover.mediaDefaults, {
        inputImages: [0, 0],
        inputAudio: [1, 1],
    });
    t.true(
        music.mediaControls.some((control) => control.key === "audioFormat"),
    );
    t.true(music.mediaControls.some((control) => control.key === "sampleRate"));
    t.true(music.mediaControls.some((control) => control.key === "bitrate"));
    t.true(
        music.mediaControls.some((control) => control.key === "isInstrumental"),
    );
    t.is(cover.mediaControls, undefined);
    t.is(music.requiredEnv, "REPLICATE_API_KEY");
    t.is(cover.requiredEnv, "REPLICATE_API_KEY");
});

test("Gemini TTS is exposed as a dedicated media category with voice controls", async (t) => {
    const { data } = await queryMetadata({ category: "tts" });
    const model = data.models.find(
        (m) => m.modelId === "google-gemini-3.1-flash-tts",
    );

    t.truthy(model);
    t.is(model.displayName, "Gemini 3.1 Flash TTS");
    t.is(model.provider, "google");
    t.is(model.pathwayName, "tts_gemini");
    t.is(model.resultKey, "tts_gemini");
    t.is(model.preferredUrlFormat, "gcs");
    t.deepEqual(model.requiredEnv, ["GCP_SERVICE_ACCOUNT_KEY", "GCP_PROJECT_ID"]);
    t.deepEqual(model.mediaDefaults, {
        voiceName: "Kore",
    });
    t.true(model.availableVoices.some((voice) => voice.value === "Kore"));
    t.deepEqual(
        model.mediaControls.find((control) => control.key === "voiceName"),
        {
            key: "voiceName",
            label: "Voice",
            type: "select",
            defaultValue: "Kore",
            options: model.availableVoices,
        },
    );
});

test("Replicate Qwen3 TTS is exposed with mode, voice, language, and clone metadata", async (t) => {
    const { data } = await queryMetadata({ category: "tts" });
    const model = data.models.find((m) => m.modelId === "replicate-qwen3-tts");

    t.truthy(model);
    t.is(model.displayName, "Qwen3 TTS");
    t.is(model.provider, "replicate");
    t.is(model.pathwayName, "tts_replicate");
    t.is(model.resultKey, "tts_replicate");
    t.is(model.preferredUrlFormat, "azure");
    t.is(model.requiredEnv, "REPLICATE_API_KEY");
    t.deepEqual(model.mediaDefaults, {
        inputAudio: [0, 1],
        mode: "custom_voice",
        language: "auto",
        speaker: "Serena",
    });
    t.deepEqual(model.mediaDefaultOverrides, [
        {
            when: {
                mode: "voice_clone",
            },
            mediaDefaults: {
                inputAudio: [1, 1],
            },
        },
    ]);
    t.true(model.availableVoices.some((voice) => voice.value === "Aiden"));
    t.true(
        model.availableLanguages.some(
            (language) => language.value === "English",
        ),
    );
    t.deepEqual(
        model.mediaControls
            .find((control) => control.key === "mode")
            ?.options.map((option) => option.value),
        ["custom_voice", "voice_clone", "voice_design"],
    );
    t.deepEqual(
        model.mediaControls.find((control) => control.key === "speaker")
            ?.showWhen,
        {
            mode: "custom_voice",
        },
    );
    t.deepEqual(
        model.mediaControls.find((control) => control.key === "referenceText")
            ?.showWhen,
        {
            mode: "voice_clone",
        },
    );
    t.is(
        model.mediaControls.find((control) => control.key === "referenceText")
            ?.placeholder,
        "Optional - transcript of the speech in the reference audio clip",
    );
    t.is(
        model.mediaControls.find(
            (control) => control.key === "styleInstruction",
        )?.placeholder,
        "Optional - speaking style, tone, or delivery notes",
    );
    t.deepEqual(
        model.mediaControls.find(
            (control) => control.key === "voiceDescription",
        )?.showWhen,
        {
            mode: "voice_design",
        },
    );
    t.is(
        model.mediaControls.find(
            (control) => control.key === "voiceDescription",
        )?.placeholder,
        "Describe the voice to design, such as age, tone, accent, and pace",
    );
    t.deepEqual(
        model.mediaControls.find((control) => control.key === "speaker")
            ?.options,
        model.availableVoices,
    );
    t.true(
        model.mediaControls.some((control) => control.key === "referenceText"),
    );
    t.true(
        model.mediaControls.some(
            (control) => control.key === "styleInstruction",
        ),
    );
    t.true(
        model.mediaControls.some(
            (control) => control.key === "voiceDescription",
        ),
    );
});

test("Replicate ElevenLabs v3 TTS is exposed with schema-backed voice controls", async (t) => {
    const { data } = await queryMetadata({ category: "tts" });
    const model = data.models.find(
        (m) => m.modelId === "replicate-elevenlabs-v3",
    );

    t.truthy(model);
    t.is(model.displayName, "ElevenLabs v3");
    t.is(model.provider, "replicate");
    t.is(model.pathwayName, "tts_replicate");
    t.is(model.resultKey, "tts_replicate");
    t.is(model.preferredUrlFormat, "azure");
    t.is(model.requiredEnv, "REPLICATE_API_KEY");
    t.deepEqual(model.mediaDefaults, {
        voice: "Rachel",
        stability: 0.5,
        similarityBoost: 0.75,
        style: 0,
        speed: 1,
        languageCode: "en",
    });
    t.true(
        model.availableVoices.some((voice) => voice.value === "Grimblewood"),
    );
    t.deepEqual(
        model.mediaControls.find((control) => control.key === "voice")?.options,
        model.availableVoices,
    );
    t.deepEqual(
        model.mediaControls.find((control) => control.key === "speed"),
        {
            key: "speed",
            label: "Speed",
            type: "number",
            min: 0.7,
            max: 1.2,
            step: 0.05,
            defaultValue: 1,
        },
    );
    t.true(
        model.mediaControls.some((control) => control.key === "previousText"),
    );
    t.true(model.mediaControls.some((control) => control.key === "nextText"));
    t.true(
        model.mediaControls.some((control) => control.key === "languageCode"),
    );
});

test("Replicate MiniMax Speech 2.8 TTS models expose schema-backed voice controls", async (t) => {
    const { data } = await queryMetadata({ category: "tts" });
    const turbo = data.models.find(
        (m) => m.modelId === "replicate-minimax-speech-2.8-turbo",
    );
    const hd = data.models.find(
        (m) => m.modelId === "replicate-minimax-speech-2.8-hd",
    );

    for (const model of [turbo, hd]) {
        t.truthy(model);
        t.is(model.provider, "replicate");
        t.is(model.pathwayName, "tts_replicate");
        t.is(model.resultKey, "tts_replicate");
        t.is(model.preferredUrlFormat, "azure");
        t.is(model.requiredEnv, "REPLICATE_API_KEY");
        t.deepEqual(model.mediaDefaults, {
            voiceId: "English_Wiselady",
            customVoiceId: "",
            speed: 1,
            volume: 1,
            pitch: 0,
            emotion: "auto",
            englishNormalization: false,
            sampleRate: 32000,
            bitrate: 128000,
            audioFormat: "mp3",
            channel: "mono",
            subtitleEnable: false,
            languageBoost: "None",
        });
        t.deepEqual(
            model.mediaControls.find((control) => control.key === "speed"),
            {
                key: "speed",
                label: "Speed",
                type: "number",
                min: 0.5,
                max: 2,
                step: 0.05,
                defaultValue: 1,
            },
        );
        t.true(model.availableVoices.length > 300);
        t.true(
            model.availableVoices.some(
                (voice) => voice.value === "English_Wiselady",
            ),
        );
        t.true(
            model.availableVoices.some(
                (voice) => voice.value === "Arabic_CalmWoman",
            ),
        );
        t.true(
            model.mediaControls
                .find((control) => control.key === "voiceId")
                ?.options.some((option) => option.value === "English_Wiselady"),
        );
        t.true(
            model.mediaControls
                .find((control) => control.key === "voiceId")
                ?.options.some((option) => option.value === "__custom"),
        );
        t.deepEqual(
            model.mediaControls.find(
                (control) => control.key === "customVoiceId",
            )?.showWhen,
            {
                voiceId: "__custom",
            },
        );
        t.true(
            model.mediaControls
                .find((control) => control.key === "emotion")
                ?.options.some((option) => option.value === "calm"),
        );
        t.true(
            model.mediaControls
                .find((control) => control.key === "languageBoost")
                ?.options.some((option) => option.value === "Arabic"),
        );
        t.true(
            model.mediaControls.some(
                (control) => control.key === "subtitleEnable",
            ),
        );
        t.true(
            model.mediaControls.some(
                (control) => control.key === "englishNormalization",
            ),
        );
    }
    t.is(turbo.displayName, "MiniMax Speech 2.8 Turbo");
    t.is(hd.displayName, "MiniMax Speech 2.8 HD");
});

test("seedream 4.5 is exposed with image metadata", async (t) => {
    const { data } = await queryMetadata({ category: "image" });
    const model = data.models.find(
        (m) => m.modelId === "replicate-seedream-4.5",
    );

    t.truthy(model);
    t.is(model.displayName, "Seedream 4.5");
    t.is(model.pathwayName, "image_seedream45");
    t.is(model.resultKey, "image_seedream45");
    t.deepEqual(model.mediaDefaults, {
        inputImages: [0, 3],
        quality: "high",
        aspectRatio: "match_input_image",
        size: "2K",
        disableSafetyChecker: false,
    });
    t.deepEqual(model.availableImageSizes, ["2K", "4K"]);
    t.true(model.availableAspectRatios.includes("21:9"));
});

test("Gemini 3.1 Flash Lite image is exposed with Gemini image metadata", async (t) => {
    const { data } = await queryMetadata({ category: "image" });
    const model = data.models.find(
        (m) => m.modelId === "gemini-flash-lite-31-image",
    );

    t.truthy(model);
    t.is(model.displayName, "Gemini 3.1 Flash Lite Image");
    t.is(model.provider, "google");
    t.is(model.type, "GEMINI-3-IMAGE");
    t.is(model.pathwayName, "image_gemini_31_lite");
    t.is(model.resultKey, "image_gemini_31_lite");
    t.is(model.preferredUrlFormat, "gcs");
    t.deepEqual(model.mediaDefaults, {
        inputImages: [0, 3],
        quality: "high",
        aspectRatio: "1:1",
        optimizePrompt: true,
    });
    t.true(model.mediaToggles.includes("optimizePrompt"));
    t.deepEqual(model.availableImageSizes, ["512", "1K", "2K", "4K"]);
    t.true(model.availableAspectRatios.includes("16:9"));
});

test("seedream 5 lite is exposed with image metadata", async (t) => {
    const { data } = await queryMetadata({ category: "image" });
    const model = data.models.find(
        (m) => m.modelId === "replicate-seedream-5-lite",
    );

    t.truthy(model);
    t.is(model.displayName, "Seedream 5 Lite");
    t.is(model.pathwayName, "image_seedream5lite");
    t.is(model.resultKey, "image_seedream5lite");
    t.deepEqual(model.mediaDefaults, {
        inputImages: [0, 3],
        quality: "high",
        aspectRatio: "match_input_image",
        size: "2K",
        output_format: "png",
    });
    t.deepEqual(model.availableImageSizes, ["2K", "3K"]);
    t.true(model.availableAspectRatios.includes("2:3"));
});

test("seedance 2.0 models are exposed with video metadata", async (t) => {
    const { data } = await queryMetadata({ category: "video" });
    const variants = [
        {
            modelId: "replicate-seedance-2.0",
            displayName: "Seedance 2.0",
            availableResolutions: ["480p", "720p", "1080p", "4k"],
        },
        {
            modelId: "replicate-seedance-2.0-fast",
            displayName: "Seedance 2.0 Fast",
            availableResolutions: ["480p", "720p"],
        },
        {
            modelId: "replicate-seedance-2.0-mini",
            displayName: "Seedance 2.0 Mini",
            availableResolutions: ["480p", "720p"],
        },
    ];

    for (const variant of variants) {
        const model = data.models.find((m) => m.modelId === variant.modelId);

        t.truthy(model);
        t.is(model.displayName, variant.displayName);
        t.is(model.pathwayName, "video_seedance");
        t.is(model.resultKey, "video_seedance");
        t.deepEqual(model.mediaDefaults, {
            inputImages: [0, 9],
            inputVideos: [0, 3],
            aspectRatio: "16:9",
            duration: 5,
            resolution: "720p",
            generateAudio: true,
        });
        t.deepEqual(model.availableResolutions, variant.availableResolutions);
        t.true(model.availableAspectRatios.includes("adaptive"));
        t.true(model.availableAspectRatios.includes("9:21"));
        t.true(model.availableDurations.includes(-1));
        t.true(model.availableDurations.includes(0));
        t.true(model.availableDurations.includes(15));
        t.deepEqual(model.referenceImageRoles, [
            "start_frame",
            "end_frame",
            "reference",
        ]);
    }
});

test("Gemini Omni Flash Preview is exposed with video metadata", async (t) => {
    const { data } = await queryMetadata({ category: "video" });
    const model = data.models.find(
        (m) => m.modelId === "gemini-omni-flash-preview",
    );

    t.truthy(model);
    t.is(model.displayName, "Gemini Omni 1.1 Flash");
    t.true(model.isDeprecated);
    t.is(model.replacementModel, "gemini-omni-1.1-flash");
    t.is(model.provider, "google");
    t.is(model.type, "GEMINI-INTERACTIONS");
    t.is(model.pathwayName, "video_gemini_omni");
    t.is(model.resultKey, "video_gemini_omni");
    t.deepEqual(model.requiredEnv, ["GCP_SERVICE_ACCOUNT_KEY", "GCP_PROJECT_ID"]);
    t.deepEqual(model.mediaDefaults, {
        inputImages: [0, 10],
        inputVideos: [0, 3],
        inputAudio: [0, 0],
        aspectRatio: "16:9",
        resolution: "720p",
        generationMode: "auto",
    });
    t.deepEqual(model.availableDurations, []);
    t.true(model.availableAspectRatios.includes("16:9"));
});

test("dreamactor m2.0 is exposed with video metadata", async (t) => {
    const { data } = await queryMetadata({ category: "video" });
    const model = data.models.find(
        (m) => m.modelId === "replicate-dreamactor-m2.0",
    );

    t.truthy(model);
    t.is(model.displayName, "DreamActor M2.0");
    t.is(model.pathwayName, "video_dreamactor");
    t.is(model.resultKey, "video_dreamactor");
    t.deepEqual(model.mediaDefaults, {
        inputImages: [1, 1],
        inputVideos: [1, 1],
        cutFirstSecond: true,
    });
    t.deepEqual(model.mediaInputModes, [
        {
            key: "imageAndVideo",
            label: "Image and Video",
            promptRequired: false,
            requires: {
                inputImages: [1, 1],
                inputVideos: [1, 1],
            },
        },
    ]);
    t.deepEqual(model.referenceImageRoles, ["reference"]);
    t.deepEqual(model.referenceImageRoleLimits, {
        reference: [1, 1],
    });
    t.deepEqual(model.mediaToggles, ["cutFirstSecond"]);
    t.deepEqual(model.availableAspectRatios, []);
    t.deepEqual(model.availableDurations, []);
});

test("p-video-avatar is exposed with video metadata and voice controls", async (t) => {
    const { data } = await queryMetadata({ category: "video" });
    const model = data.models.find(
        (m) => m.modelId === "replicate-p-video-avatar",
    );

    t.truthy(model);
    t.is(model.displayName, "P-Video Avatar");
    t.is(model.provider, "replicate");
    t.is(model.pathwayName, "video_avatar");
    t.is(model.resultKey, "video_avatar");
    t.deepEqual(model.mediaDefaults, {
        inputImages: [1, 1],
        inputAudio: [0, 1],
        resolution: "720p",
        voice: "Zephyr (Female)",
        voiceScript: "",
        voiceLanguage: "English (US)",
        voicePrompt: "Say the following.",
        videoPrompt: "The person is talking.",
        negativePrompt: "",
        strengthNegativePrompt: 0.5,
        disableSafetyFilter: true,
        disablePromptUpsampling: false,
    });
    t.deepEqual(model.mediaInputModes, [
        {
            key: "audioTrack",
            label: "Audio Track",
            promptRequired: false,
            requires: {
                inputImages: [1, 1],
                inputAudio: [1, 1],
            },
        },
        {
            key: "generatedVoice",
            label: "Generated Voice",
            promptRequired: false,
            requires: {
                inputImages: [1, 1],
            },
            requiresAnyOf: [
                {
                    setting: "voiceScript",
                },
                {
                    prompt: true,
                },
            ],
        },
    ]);
    t.deepEqual(model.referenceImageRoles, ["reference"]);
    t.deepEqual(model.referenceImageRoleLimits, {
        reference: [1, 1],
    });
    t.deepEqual(model.mediaToggles, [
        "disableSafetyFilter",
        "disablePromptUpsampling",
    ]);
    t.deepEqual(model.availableResolutions, ["720p", "1080p"]);
    t.deepEqual(model.availableAspectRatios, []);
    t.deepEqual(model.availableDurations, []);
    t.deepEqual(
        model.mediaControls
            .find((control) => control.key === "voice")
            ?.options.map((option) => option.value)
            .slice(0, 4),
        ["Zephyr (Female)", "Puck (Male)", "Charon (Male)", "Kore (Female)"],
    );
    for (const key of [
        "voice",
        "voiceScript",
        "voiceLanguage",
        "voicePrompt",
    ]) {
        t.deepEqual(
            model.mediaControls.find((control) => control.key === key)
                ?.hideWhen,
            {
                inputAudioAttached: true,
            },
        );
    }
    t.deepEqual(
        model.mediaControls
            .find((control) => control.key === "voiceLanguage")
            ?.options.map((option) => option.value),
        [
            "English (US)",
            "English (UK)",
            "Spanish",
            "French",
            "German",
            "Italian",
            "Portuguese (Brazil)",
            "Japanese",
            "Korean",
            "Hindi",
        ],
    );
    const strengthControl = model.mediaControls.find(
        (control) => control.key === "strengthNegativePrompt",
    );
    t.is(strengthControl?.type, "number");
    t.is(strengthControl?.min, 0);
    t.is(strengthControl?.max, 4);
});

test("video upscaler is exposed as an upscaling model with schema controls", async (t) => {
    const { data } = await queryMetadata({ category: "upscaling" });
    const model = data.models.find(
        (m) => m.modelId === "replicate-video-upscaler",
    );

    t.truthy(model);
    t.is(model.displayName, "ByteDance Video Upscaler");
    t.is(model.provider, "replicate");
    t.is(model.pathwayName, "video_upscaler");
    t.is(model.resultKey, "video_upscaler");
    t.deepEqual(model.mediaDefaults, {
        inputVideos: [1, 1],
        processingType: "standard",
        scene: "aigc",
        targetResolution: "4k",
        targetFps: 60,
    });
    t.deepEqual(model.mediaInputModes, [
        {
            key: "videoUpscale",
            label: "Video Upscale",
            promptRequired: false,
            requires: {
                inputVideos: [1, 1],
            },
        },
    ]);
    t.deepEqual(
        model.mediaControls
            .find((control) => control.key === "processingType")
            ?.options.map((option) => option.value),
        ["standard", "pro"],
    );
    t.deepEqual(
        model.mediaControls
            .find((control) => control.key === "scene")
            ?.options.map((option) => option.value),
        ["aigc", "short_series", "ugc", "old_film", "common"],
    );
    t.deepEqual(
        model.mediaControls
            .find((control) => control.key === "targetResolution")
            ?.options.map((option) => option.value),
        ["240p", "360p", "480p", "540p", "720p", "1080p", "2k", "4k"],
    );
    t.deepEqual(
        model.mediaControls
            .find((control) => control.key === "targetFps")
            ?.options.map((option) => option.value),
        [24, 30, 60, 120],
    );
});

test("Topaz image upscaler is exposed as an upscaling model with schema controls", async (t) => {
    const { data } = await queryMetadata({ category: "upscaling" });
    const model = data.models.find(
        (m) => m.modelId === "replicate-topaz-image-upscale",
    );

    t.truthy(model);
    t.is(model.displayName, "Topaz Image Upscale");
    t.is(model.provider, "replicate");
    t.is(model.pathwayName, "image_upscaler");
    t.is(model.resultKey, "image_upscaler");
    t.deepEqual(model.mediaDefaults, {
        inputImages: [1, 1],
        enhanceModel: "Standard V2",
        upscaleFactor: "None",
        outputFormat: "jpg",
        subjectDetection: "None",
        faceEnhancement: false,
        faceEnhancementCreativity: 0,
        faceEnhancementStrength: 0.8,
    });
    t.deepEqual(model.mediaInputModes, [
        {
            key: "imageUpscale",
            label: "Image Upscale",
            promptRequired: false,
            requires: {
                inputImages: [1, 1],
            },
        },
    ]);
    t.deepEqual(
        model.mediaControls
            .find((control) => control.key === "enhanceModel")
            ?.options.map((option) => option.value),
        [
            "Standard V2",
            "Low Resolution V2",
            "CGI",
            "High Fidelity V2",
            "Text Refine",
        ],
    );
    t.deepEqual(
        model.mediaControls
            .find((control) => control.key === "upscaleFactor")
            ?.options.map((option) => option.value),
        ["None", "2x", "4x", "6x"],
    );
    t.deepEqual(
        model.mediaControls
            .find((control) => control.key === "outputFormat")
            ?.options.map((option) => option.value),
        ["jpg", "png"],
    );
    t.deepEqual(
        model.mediaControls
            .find((control) => control.key === "subjectDetection")
            ?.options.map((option) => option.value),
        ["None", "All", "Foreground", "Background"],
    );
    t.is(
        model.mediaControls.find((control) => control.key === "faceEnhancement")
            ?.type,
        "boolean",
    );
    t.deepEqual(
        model.mediaControls
            .filter(
                (control) =>
                    control.key.startsWith("faceEnhancement") &&
                    control.type === "number",
            )
            .map((control) => [control.key, control.min, control.max]),
        [
            ["faceEnhancementCreativity", 0, 1],
            ["faceEnhancementStrength", 0, 1],
        ],
    );
    t.deepEqual(model.availableAspectRatios, []);
    t.deepEqual(model.availableDurations, []);
});

test("Topaz video upscaler is exposed as an upscaling model with schema controls", async (t) => {
    const { data } = await queryMetadata({ category: "upscaling" });
    const model = data.models.find(
        (m) => m.modelId === "replicate-topaz-video-upscale",
    );

    t.truthy(model);
    t.is(model.displayName, "Topaz Video Upscale");
    t.is(model.provider, "replicate");
    t.is(model.pathwayName, "video_upscaler");
    t.is(model.resultKey, "video_upscaler");
    t.deepEqual(model.mediaDefaults, {
        inputVideos: [1, 1],
        targetResolution: "1080p",
        targetFps: 30,
    });
    t.deepEqual(model.mediaInputModes, [
        {
            key: "videoUpscale",
            label: "Video Upscale",
            promptRequired: false,
            requires: {
                inputVideos: [1, 1],
            },
        },
    ]);
    t.deepEqual(
        model.mediaControls
            .find((control) => control.key === "targetResolution")
            ?.options.map((option) => option.value),
        ["720p", "1080p", "4k"],
    );
    const targetFpsControl = model.mediaControls.find(
        (control) => control.key === "targetFps",
    );
    t.is(targetFpsControl?.type, "number");
    t.is(targetFpsControl?.min, 15);
    t.is(targetFpsControl?.max, 60);
    t.is(targetFpsControl?.defaultValue, 30);
    t.deepEqual(model.availableAspectRatios, []);
    t.deepEqual(model.availableDurations, []);
});

test("video metadata exposes per-image reference roles for supported models", async (t) => {
    const { data } = await queryMetadata({ category: "video" });
    const veoModels = data.models.filter((m) =>
        m.modelId.startsWith("veo-3.1"),
    );
    const kling = data.models.find(
        (m) => m.modelId === "replicate-kling-v2.5-turbo-pro",
    );

    t.is(veoModels.length, 3);
    for (const model of veoModels) {
        const isLite = model.modelId === "veo-3.1-lite-generate";
        t.deepEqual(model.referenceImageRoles, [
            "start_frame",
            "end_frame",
            "reference",
        ]);
        t.deepEqual(model.mediaDefaults.inputImages, isLite ? [0, 2] : [0, 3]);
        t.deepEqual(model.videoFrameReferenceRoles, [
            "start_frame",
            "end_frame",
        ]);
        t.deepEqual(model.referenceImageRoleLimits.start_frame, [0, 1]);
        t.deepEqual(model.referenceImageRoleLimits.end_frame, [0, 1]);
        t.deepEqual(
            model.referenceImageRoleLimits.reference,
            isLite ? [0, 1] : [0, 3],
        );
    }
    for (const model of veoModels) {
        t.deepEqual(model.mediaDefaults.inputVideos, [0, 1]);
        t.deepEqual(model.videoInputModes, ["extend"]);
        t.is(model.mediaDefaults.resolution, "720p");
        t.deepEqual(
            model.availableResolutions,
            model.modelId === "veo-3.1-lite-generate"
                ? ["720p", "1080p"]
                : ["720p"],
        );
    }

    t.truthy(kling);
    t.deepEqual(kling.referenceImageRoles, ["start_frame", "end_frame"]);
    t.deepEqual(kling.videoFrameReferenceRoles, ["start_frame", "end_frame"]);
    t.deepEqual(kling.referenceImageRoleLimits, {
        start_frame: [0, 1],
        end_frame: [0, 1],
    });
});

test("each category has exactly one default model", async (t) => {
    const { data } = await queryMetadata();

    for (const category of ["chat", "image", "video"]) {
        const categoryModels = data.models.filter(
            (m) => m.category === category,
        );
        const defaults = categoryModels.filter((m) => m.isDefault);
        t.is(
            defaults.length,
            1,
            `category '${category}' should have exactly 1 default, got ${defaults.length}`,
        );
    }
});

test.serial("retired picker entries keep their IDs and depend on replacement availability", async t => {
    const original = config.get("geminiApiKey");
    try {
        config.set("geminiApiKey", "");
        let { data } = await queryMetadata();
        const find = id => data.models.find(m => m.modelId === id);
        t.falsy(find("google-lyria-3-pro-music").isDeprecated);
        config.set("geminiApiKey", "contract-test-key");
        ({ data } = await queryMetadata());
        t.true(find("google-lyria-3-pro-music").isDeprecated);
        t.is(find("google-lyria-3-pro-music").pathwayName, "music_lyria_pro");
        t.is(find("google-lyria-3-pro-music").replacementModel, "google-lyria-3.5-music");
        t.true(find("gemini-omni-flash-preview").isDeprecated);
        t.false(find("azure-mai-image-2.6-flash").isAvailable);
    } finally { config.set("geminiApiKey", original); }
});
