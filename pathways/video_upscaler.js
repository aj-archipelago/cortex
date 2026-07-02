export default {
    prompt: ["{{{text}}}"],

    enableDuplicateRequests: false,
    inputParameters: {
        model: "replicate-video-upscaler",
        video: "",
        processing_type: "standard",
        scene: "aigc",
        target_resolution: "4k",
        target_fps: 60,
    },

    timeout: 60 * 30, // 30 minutes
};
