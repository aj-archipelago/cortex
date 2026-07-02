import test from "ava";
import { PARAM_MAPPERS } from "../../../pathways/media_generate.js";
import imageGemini31Lite from "../../../pathways/image_gemini_31_lite.js";

test("Gemini Flash Lite image pathway uses the Lite model", (t) => {
    t.is(imageGemini31Lite.model, "gemini-flash-lite-31-image");
});

test("media_generate maps Gemini Flash Lite image through the Gemini 3 image contract", (t) => {
    const mapped = PARAM_MAPPERS.image_gemini_31_lite(
        {
            text: "A detailed editorial illustration",
            model: "gemini-flash-lite-31-image",
            optimizePrompt: true,
            aspectRatio: "16:9",
            imageSize: "1K",
        },
        [
            "gs://bucket/reference-1.png",
            "gs://bucket/reference-2.png",
            "gs://bucket/reference-3.png",
            "gs://bucket/reference-4.png",
        ],
    );

    t.deepEqual(mapped, {
        text: "A detailed editorial illustration",
        model: "gemini-flash-lite-31-image",
        optimizePrompt: true,
        aspectRatio: "16:9",
        image_size: "1K",
        input_image: "gs://bucket/reference-1.png",
        input_image_2: "gs://bucket/reference-2.png",
        input_image_3: "gs://bucket/reference-3.png",
        input_image_4: "gs://bucket/reference-4.png",
    });
});

test("media_generate maps Gemini Omni video through the interactions contract", (t) => {
    const mapped = PARAM_MAPPERS.video_gemini_omni(
        {
            text: "A cinematic newsroom intro",
            model: "gemini-omni-flash-preview",
            contextId: "ctx-omni",
        },
        ["gs://bucket/reference-1.png", "gs://bucket/reference-2.png"],
        ["gs://bucket/motion-reference.mp4"],
        ["gs://bucket/audio-reference.wav"],
    );

    t.deepEqual(mapped, {
        text: "A cinematic newsroom intro",
        model: "gemini-omni-flash-preview",
        input_images: [
            "gs://bucket/reference-1.png",
            "gs://bucket/reference-2.png",
        ],
        input_videos: ["gs://bucket/motion-reference.mp4"],
        input_audios: ["gs://bucket/audio-reference.wav"],
        contextId: "ctx-omni",
    });
});
