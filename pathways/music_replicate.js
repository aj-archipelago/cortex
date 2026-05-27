export default {
  prompt: ["{{text}}"],

  enableDuplicateRequests: false,
  inputParameters: {
    model: "replicate-elevenlabs-music",
    duration: 10,
    outputFormat: "wav_cd_quality",
    forceInstrumental: true,
    inputAudioUrl: "",
    audioUrl: "",
    audioFormat: "",
    sampleRate: 0,
    bitrate: 0,
    lyrics: "",
    isInstrumental: false,
    lyricsOptimizer: false,
  },

  timeout: 60 * 16,
};
