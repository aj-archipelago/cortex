export default {
  prompt: ["{{text}}"],

  enableDuplicateRequests: false,
  inputParameters: {
    model: "runware-flux-schnell",
    negativePrompt: "",
    width: 1024,
    height: 1024,
    aspectRatio: "custom",
    numberResults: 1,
    safety_tolerance: 6,
    output_format: "webp",
    output_quality: 80,
    steps: 4,
    input_image: "", // URL to input image for models that support it
    input_image_1: "", // First input image URL
    input_image_2: "", // URL to second input image for models that support it
    input_image_3: "", // Third input image URL
    input_images: { type: "array", items: { type: "string" } }, // Array of input images (max 8 for flux-2-pro)
    // Flux 2 Pro specific parameters
    resolution: "1 MP", // Options: "match_input_image", "0.5 MP", "1 MP", "2 MP", "4 MP" (flux-2-pro only)
    seed: { type: "integer" }, // Optional seed for reproducible results
  },
};
