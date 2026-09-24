import { priorityMediaParameters } from "../lib/priorityMediaParameters.js";

export default {
    prompt: ["{{{text}}}"],
    // Keep the fallback in inputParameters: a top-level model overrides args.model.
    inputParameters: {
        model: "replicate-qwen-image-3-pro",
        inputImages: { type: "array", items: { type: "string" } },
        inputImageRoles: { type: "array", items: { type: "string" } },
        inputVideos: { type: "array", items: { type: "string" } },
        inputAudio: { type: "array", items: { type: "string" } },
        aspectRatio: { type: "string" },
        duration: { type: "integer" },
        resolution: { type: "string" },
        size: { type: "string" },
        outputFormat: { type: "string" },
        negativePrompt: { type: "string" },
        generateAudio: { type: "boolean" },
        seed: { type: "integer" },
        quality: { type: "string" },
        numberResults: { type: "integer" },
        ...priorityMediaParameters,
    },
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 60 * 35,
};
