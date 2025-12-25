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
    input_image: "", // URL to a single input image (primary field for models that support image input)
    input_image_1: "", // URL to the first input image when providing multiple input images
    input_image_2: "", // URL to the second input image when providing multiple input images
    input_image_3: "", // URL to the third input image when providing multiple input images
    input_images: { type: "array", items: { type: "string" } }, // Array of input image URLs (alternative to input_image_*, max 8 for flux-2-pro)
    // Flux 2 Pro specific parameters
    resolution: "1 MP", // Options: "match_input_image", "0.5 MP", "1 MP", "2 MP", "4 MP" (flux-2-pro only)
    seed: { type: "integer" }, // Optional seed for reproducible results
  },
};
