export default {
  prompt: ["{{text}}"],

  enableDuplicateRequests: false,
  inputParameters: {
    model: "replicate-qwen-image", // Options: "replicate-qwen-image", "replicate-qwen-image-edit-plus", or "replicate-qwen-image-edit-2511"
    negativePrompt: "",
    width: 1024,
    height: 1024,
    aspectRatio: "16:9", // Options: "1:1", "16:9", "9:16", "4:3", "3:4", "match_input_image" (use "match_input_image" for qwen-image-edit-plus)
    numberResults: 1,
    output_format: "webp",
    output_quality: 80, // Use 95 for qwen-image-edit-plus
    input_image: "", // URL to input image for replicate-qwen-image-edit-plus
    input_image_2: "", // URL to second input image for replicate-qwen-image-edit-plus
    input_image_3: "", // URL to third input image for replicate-qwen-image-edit-plus
    
    // Qwen-specific parameters
    go_fast: true,
    guidance: { type: 'number', default: 4.0 }, // For replicate-qwen-image only
    strength: 0.9,
    image_size: "optimize_for_quality", // For replicate-qwen-image only
    lora_scale: { type: 'number', default: 1.0 }, // For replicate-qwen-image only
    enhance_prompt: false, // For replicate-qwen-image only
    num_inference_steps: 50, // For replicate-qwen-image only
    disable_safety_checker: false,
  },
};
