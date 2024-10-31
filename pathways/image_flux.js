export default {
  prompt: ["{{text}}"],

  enableDuplicateRequests: false,
  inputParameters: {
    model: "runware-flux-schnell",
    negativePrompt: "",
    width: 512,
    height: 512,
    numberResults: 1,
    safety_tolerance: 5,
    output_format: "png",
    output_quality: 80,
    steps: 4,
  },
};
