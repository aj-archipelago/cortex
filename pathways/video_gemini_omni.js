export default {
    prompt: ["{{{text}}}"],

    enableDuplicateRequests: false,
    inputParameters: {
        text: "",
        model: "gemini-omni-flash-preview",
        input_image: "",
        input_image_2: "",
        input_image_3: "",
        input_image_4: "",
        input_image_5: "",
        input_images: { type: "array", items: { type: "string" } },
        input_video: "",
        input_videos: { type: "array", items: { type: "string" } },
        input_audio: "",
        input_audios: { type: "array", items: { type: "string" } },
        contextId: "",
    },

    model: "gemini-omni-flash-preview",
    timeout: 60 * 15,
};
