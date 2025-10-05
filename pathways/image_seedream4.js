export default {
  prompt: ["{{text}}"],

  enableDuplicateRequests: false,
  inputParameters: {
    model: "replicate-seedream-4",
    size: "2K", // Options: "1K", "2K", "4K", "custom"
    width: 2048, // Custom width (1024-4096px, only used when size="custom")
    height: 2048, // Custom height (1024-4096px, only used when size="custom")
    aspectRatio: "4:3", // Options: "1:1", "4:3", "3:4", "16:9", "9:16", "match_input_image"
    maxImages: 1, // Maximum number of images to generate (1-15)
    numberResults: 1, // Alternative parameter name for maxImages
    imageInput: [], // Array of input images (1-10 images for image-to-image generation)
    // Multiple input image parameters (same pattern as qwen-image-edit-plus)
    input_image: "", // Single input image URL
    input_image_1: "", // First input image URL
    input_image_2: "", // Second input image URL  
    input_image_3: "", // Third input image URL
    image: "", // Alternative single image parameter
    image_1: "", // Alternative first image parameter
    image_2: "", // Alternative second image parameter
    images: [], // Alternative array of images
    input_images: [], // Alternative array of input images
    sequentialImageGeneration: "disabled", // Options: "disabled", "auto"
    seed: 0, // Optional seed for reproducible results
  },
};
