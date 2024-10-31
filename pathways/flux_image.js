export default {
  prompt: ["{{text}}"],

  enableDuplicateRequests: false,
  inputParameters: {
    model: "runware-flux-schnell",
    negativePrompt: "",
    width: 512,
    height: 512,
    numberResults: 1,
    steps: 4,
  },
};
