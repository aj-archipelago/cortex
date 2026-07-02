export default {
  prompt: ["{{text}}"],

  inputParameters: {
    text: "",
    input_images: { type: "array", items: { type: "string" } },
    input_image: "",
    input_image_mime_type: "",
    contextId: "",
  },

  max_tokens: 8192,
  model: "google-lyria-3-music",
  useInputChunking: false,
  timeout: 60 * 10,
};
