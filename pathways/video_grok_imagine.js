export default {
  prompt: ["{{text}}"],

  inputParameters: {
    model: "replicate-grok-imagine-video",
    aspectRatio: "auto",
    duration: 5,
    resolution: "720p",
    image: "",
    video: "",
  },

  timeout: 60 * 30, // 30 minutes
};
