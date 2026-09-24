export default {
    prompt: ["{{{text}}}"],

    inputParameters: {
        text: "",
        model: "gemini-omni-1.1-flash",
        generationMode: { type: "string" },
        inputImageRoles: { type: "array", items: { type: "string" } },
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
        aspectRatio: { type: "string" },
        resolution: { type: "string" },
    },

    // This pathway serves multiple Omni versions; args.model selects the endpoint.
    timeout: 60 * 15,
};
