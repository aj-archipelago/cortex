export default {
  prompt: ["{{text}}"],
  model: "runware-flux-schnell",
  enableDuplicateRequests: false,
  inputParameters: {
    negativePrompt: "",
    width: 512,
    height: 512,
    numberResults: 1,
    steps: 4,
  },
};
