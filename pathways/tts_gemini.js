export default {
  prompt: ["{{{text}}}"],

  inputParameters: {
    text: "",
    voiceName: "Kore",
    speaker1Name: "",
    speaker1VoiceName: "",
    speaker2Name: "",
    speaker2VoiceName: "",
  },

  max_tokens: 8192,
  model: "google-gemini-3.1-flash-tts",
  useInputChunking: false,
  enableDuplicateRequests: false,
  timeout: 60 * 5,
};
