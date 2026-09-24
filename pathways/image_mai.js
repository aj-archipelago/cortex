export default {
  prompt: ["{{{text}}}"],
  model: "azure-mai-image-2.6-flash",
  inputParameters: {
    input_image: "",
    size: "1024x1024",
    autoAspectRatio: { type: "boolean" },
    webGrounding: { type: "boolean" },
  },
  timeout: 600,
  enableDuplicateRequests: false,
};
