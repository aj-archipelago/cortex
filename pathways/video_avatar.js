export default {
    prompt: ["{{{text}}}"],

    enableDuplicateRequests: false,
    inputParameters: {
        model: "replicate-p-video-avatar",
        image: "",
        audio: "",
        voice: "Zephyr (Female)",
        voice_script: "",
        voice_language: "English (US)",
        voice_prompt: "Say the following.",
        resolution: "720p",
        video_prompt: "The person is talking.",
        negative_prompt: "",
        strength_negative_prompt: 0.5,
        disable_safety_filter: true,
        disable_prompt_upsampling: false,
        no_op: false,
        seed: null,
    },

    timeout: 60 * 30, // 30 minutes
};
