// video_veo.js
// Pathway for generating videos using Google's Veo model via Vertex AI
//
// Model-specific constraints:
// - Veo 3.1 / 3.1 Fast: durationSeconds always 8 for text/image generation,
//   generateAudio supported, supports video extension
// - Veo 3.1 Lite: durationSeconds 4/6/8, generateAudio supported

export default {
  prompt: ["Generate a video based on the following description: {{text}}"],

  enableDuplicateRequests: false,
  inputParameters: {
    text: "",
    image: "",
    video: "",
    lastFrame: "",
    referenceImages: { type: "array", items: { type: "object" } },
    model: "veo-3.1-generate",
    aspectRatio: "16:9",
    durationSeconds: 8,
    enhancePrompt: true,
    generateAudio: true,
    resolution: "",
    negativePrompt: "",
    personGeneration: "allow_all",
    sampleCount: 1,
    storageUri: "",
    location: "us-central1",
    seed: -1,
  },

  timeout: 60 * 30, // 30 minutes
};
