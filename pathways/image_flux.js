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
    safety_tolerance: 5,
    output_format: "webp",
    output_quality: 80,
    steps: 4,
  },
};
