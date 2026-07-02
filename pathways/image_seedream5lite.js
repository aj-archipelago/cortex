export default {
  prompt: ["{{text}}"],
  inputParameters: {
    model: "replicate-seedream-5-lite",
    size: "2K", // Options: "2K", "3K"
    aspectRatio: "match_input_image", // Options: "match_input_image", "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"
    output_format: "png", // Options: "png", "jpeg"
    maxImages: 1, // Maximum number of images to generate (1-15)
    numberResults: 1, // Alternative parameter name for maxImages
    imageInput: [], // Array of input images (1-14 images for image-to-image generation)
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
  },
};
