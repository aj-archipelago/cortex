export default {
    prompt: ["{{{text}}}"],

    inputParameters: {
        model: "replicate-topaz-image-upscale",
        image: "",
        enhance_model: "Standard V2",
        upscale_factor: "None",
        output_format: "jpg",
        subject_detection: "None",
        face_enhancement: false,
        face_enhancement_creativity: 0,
        face_enhancement_strength: 0.8,
    },

    timeout: 60 * 30, // 30 minutes
};
