import test from "ava";
import { PARAM_MAPPERS } from "../../../pathways/media_generate.js";
import imageUpscalerPathway from "../../../pathways/image_upscaler.js";
import videoAvatarPathway from "../../../pathways/video_avatar.js";
import videoDreamactorPathway from "../../../pathways/video_dreamactor.js";
import videoUpscalerPathway from "../../../pathways/video_upscaler.js";

test("direct Replicate media pathways execute one prompt even when text is empty", (t) => {
    t.deepEqual(imageUpscalerPathway.prompt, ["{{{text}}}"]);
    t.deepEqual(videoAvatarPathway.prompt, ["{{{text}}}"]);
    t.deepEqual(videoDreamactorPathway.prompt, ["{{{text}}}"]);
    t.deepEqual(videoUpscalerPathway.prompt, ["{{{text}}}"]);
});

test("media_generate maps Veo image roles to start, end, and asset references", (t) => {
    const mapped = PARAM_MAPPERS.video_veo(
        {
            text: "a product reveal",
            model: "veo-3.1-fast-generate",
            inputImageRoles: ["start_frame", "reference", "end_frame"],
            duration: 8,
            generateAudio: true,
        },
        [
            "gs://bucket/start.png",
            "gs://bucket/product.png",
            "gs://bucket/end.jpg",
        ],
    );

    t.deepEqual(JSON.parse(mapped.image), {
        gcsUri: "gs://bucket/start.png",
        mimeType: "image/png",
    });
    t.deepEqual(JSON.parse(mapped.lastFrame), {
        gcsUri: "gs://bucket/end.jpg",
        mimeType: "image/jpeg",
    });
    t.deepEqual(mapped.referenceImages, [
        {
            image: {
                gcsUri: "gs://bucket/product.png",
                mimeType: "image/png",
            },
            referenceType: "asset",
        },
    ]);
});

test("media_generate rejects unsupported Veo image role formats before provider submission", (t) => {
    const error = t.throws(() =>
        PARAM_MAPPERS.video_veo(
            {
                text: "a product reveal",
                model: "veo-3.1-fast-generate",
                inputImageRoles: ["start_frame", "reference", "end_frame"],
            },
            [
                "gs://bucket/start.png",
                "gs://bucket/product.webp",
                "gs://bucket/end.jpg",
            ],
        ),
    );

    t.regex(error.message, /Veo image references must be JPEG or PNG/);
    t.regex(error.message, /webp/);
});

test("media_generate preserves generic Veo image behavior when roles are absent", (t) => {
    const mapped = PARAM_MAPPERS.video_veo(
        {
            text: "a product reveal",
            model: "veo-3.1-fast-generate",
        },
        ["gs://bucket/start.png", "gs://bucket/ignored.png"],
    );

    t.deepEqual(JSON.parse(mapped.image), {
        gcsUri: "gs://bucket/start.png",
        mimeType: "image/png",
    });
    t.is(mapped.lastFrame, "");
    t.deepEqual(mapped.referenceImages, []);
});

test("media_generate maps Veo input video to extension payload", (t) => {
    const mapped = PARAM_MAPPERS.video_veo(
        {
            text: "continue the camera move into the garden",
            model: "veo-3.1-generate",
        },
        [],
        ["gs://bucket/base.mp4"],
    );

    t.deepEqual(JSON.parse(mapped.video), {
        gcsUri: "gs://bucket/base.mp4",
        mimeType: "video/mp4",
    });
    t.is(mapped.resolution, "720p");
});

test("media_generate rejects unsupported Veo extension video formats before provider submission", (t) => {
    const error = t.throws(() =>
        PARAM_MAPPERS.video_veo(
            {
                text: "continue the camera move",
                model: "veo-3.1-generate",
            },
            [],
            ["gs://bucket/base.mov"],
        ),
    );

    t.regex(error.message, /requires MP4 input/);
    t.regex(error.message, /mov/);
});

test("media_generate maps Seedance 2.0 image roles to provider fields", (t) => {
    for (const model of [
        "replicate-seedance-2.0",
        "replicate-seedance-2.0-fast",
        "replicate-seedance-2.0-mini",
    ]) {
        const mapped = PARAM_MAPPERS.video_seedance(
            {
                text: "a character walking through a city",
                model,
                inputImageRoles: ["reference", "start_frame", "end_frame"],
                duration: 7,
            },
            [
                "https://example.com/character.png",
                "https://example.com/start.png",
                "https://example.com/end.png",
            ],
            [],
            ["https://example.com/dialogue.wav"],
        );

        t.is(mapped.image, "https://example.com/start.png");
        t.is(mapped.last_frame_image, "https://example.com/end.png");
        t.deepEqual(mapped.reference_images, [
            "https://example.com/character.png",
        ]);
        t.deepEqual(mapped.reference_audios, [
            "https://example.com/dialogue.wav",
        ]);
    }
});

test("media_generate maps Kling image roles to start and end images", (t) => {
    const mapped = PARAM_MAPPERS.video_kling(
        {
            text: "a camera push-in",
            model: "replicate-kling-v2.5-turbo-pro",
            inputImageRoles: ["end_frame", "start_frame"],
        },
        ["https://example.com/end.png", "https://example.com/start.png"],
    );

    t.is(mapped.start_image, "https://example.com/start.png");
    t.is(mapped.end_image, "https://example.com/end.png");
    t.is(mapped.image, "https://example.com/start.png");
});

test("media_generate maps DreamActor image and video inputs to provider fields", (t) => {
    const mapped = PARAM_MAPPERS.video_dreamactor(
        {
            model: "replicate-dreamactor-m2.0",
            cutFirstSecond: false,
        },
        ["https://example.com/subject.png"],
        ["https://example.com/template.mp4"],
    );

    t.deepEqual(mapped, {
        model: "replicate-dreamactor-m2.0",
        image: "https://example.com/subject.png",
        video: "https://example.com/template.mp4",
        cut_first_second: false,
    });
});

test("media_generate maps P-Video Avatar image and audio inputs to provider fields", (t) => {
    const mapped = PARAM_MAPPERS.video_avatar(
        {
            model: "replicate-p-video-avatar",
            voice: "Kore (Female)",
            voiceScript: "Bonjour",
            voiceLanguage: "French",
            voicePrompt: "Warm and clear",
            videoPrompt: "The person speaks to camera.",
            resolution: "1080p",
            negativePrompt: "subtitles",
            strengthNegativePrompt: 0.75,
            disableSafetyFilter: false,
            disablePromptUpsampling: true,
            seed: 123,
        },
        ["https://example.com/avatar.png"],
        [],
        ["https://example.com/voice.wav"],
    );

    t.deepEqual(mapped, {
        model: "replicate-p-video-avatar",
        image: "https://example.com/avatar.png",
        audio: "https://example.com/voice.wav",
        resolution: "1080p",
        video_prompt: "The person speaks to camera.",
        negative_prompt: "subtitles",
        strength_negative_prompt: 0.75,
        disable_safety_filter: false,
        disable_prompt_upsampling: true,
        no_op: false,
        seed: 123,
    });
});

test("media_generate maps Video Upscaler input video and enhancement controls", (t) => {
    const mapped = PARAM_MAPPERS.video_upscaler(
        {
            model: "replicate-video-upscaler",
            processingType: "pro",
            scene: "old_film",
            targetResolution: "2k",
            targetFps: 120,
        },
        [],
        ["https://example.com/source.mp4"],
    );

    t.deepEqual(mapped, {
        model: "replicate-video-upscaler",
        video: "https://example.com/source.mp4",
        processing_type: "pro",
        scene: "old_film",
        target_resolution: "2k",
        target_fps: 120,
    });
});

test("media_generate maps Topaz image upscaler input image and enhancement controls", (t) => {
    const mapped = PARAM_MAPPERS.image_upscaler(
        {
            model: "replicate-topaz-image-upscale",
            enhanceModel: "Low Resolution V2",
            upscaleFactor: "4x",
            outputFormat: "png",
            subjectDetection: "Foreground",
            faceEnhancement: true,
            faceEnhancementCreativity: 0.5,
            faceEnhancementStrength: 0.7,
        },
        ["https://example.com/source.webp"],
    );

    t.deepEqual(mapped, {
        model: "replicate-topaz-image-upscale",
        image: "https://example.com/source.webp",
        enhance_model: "Low Resolution V2",
        upscale_factor: "4x",
        output_format: "png",
        subject_detection: "Foreground",
        face_enhancement: true,
        face_enhancement_creativity: 0.5,
        face_enhancement_strength: 0.7,
    });
});

test("media_generate maps Topaz video upscaler controls through shared video mapper", (t) => {
    const mapped = PARAM_MAPPERS.video_upscaler(
        {
            model: "replicate-topaz-video-upscale",
            targetResolution: "4k",
            targetFps: 60,
        },
        [],
        ["https://example.com/source.mp4"],
    );

    t.deepEqual(mapped, {
        model: "replicate-topaz-video-upscale",
        video: "https://example.com/source.mp4",
        target_resolution: "4k",
        target_fps: 60,
    });

    const defaultMapped = PARAM_MAPPERS.video_upscaler(
        {
            model: "replicate-topaz-video-upscale",
        },
        [],
        ["https://example.com/source.mp4"],
    );

    t.deepEqual(defaultMapped, {
        model: "replicate-topaz-video-upscale",
        video: "https://example.com/source.mp4",
        target_resolution: "1080p",
        target_fps: 30,
    });
});
