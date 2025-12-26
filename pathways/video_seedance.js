export default {
  prompt: ["{{text}}"],

  enableDuplicateRequests: false,
  inputParameters: {
    model: "replicate-seedance-1-pro",
    resolution: "1080p",
    aspectRatio: "16:9",
    fps: 24,
    duration: 5,
    image: "",
    camera_fixed: false,
    seed: -1,
    generate_audio: false,
    last_frame_image: "",
  },

  timeout: 60 * 30, // 30 minutes
};
