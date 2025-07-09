// video_veo.js
// Pathway for generating videos using Google's Veo model via Vertex AI
//
// Model-specific constraints:
// - Veo 2.0: durationSeconds 5-8, no generateAudio, supports lastFrame/video
// - Veo 3.0: durationSeconds always 8, generateAudio required, no lastFrame/video

export default {
  prompt: ["Generate a video based on the following description: {{text}}"],
  
  enableDuplicateRequests: false,
  inputParameters: {
    text: "",
    image: "",
    video: "",
    lastFrame: "",
    model: "veo-2.0-generate",
    aspectRatio: "16:9",
    durationSeconds: 8, // 5-8 for 2.0, always 8 for 3.0
    enhancePrompt: true,
    generateAudio: false, // not supported in 2.0, required in 3.0
    negativePrompt: "",
    personGeneration: "allow_all",
    sampleCount: 1,
    storageUri: "",
    location: "us-central1",
    seed: -1,
  },

  timeout: 60 * 30, // 30 minutes
}; 