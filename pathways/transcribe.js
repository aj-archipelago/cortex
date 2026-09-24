import { executeReplicateTranscription } from "./shared/transcribe_replicate/pathway.js";

export default {
    prompt: `{{text}}`,
    model: `oai-whisper`,
    inputParameters: {
        file: ``,
        language: ``,
        responseFormat: `text`,
        wordTimestamped: false,
        highlightWords: false,
        maxLineWidth: 0,
        maxLineCount: 0,
        maxWordsPerLine: 0,
        contextId: ``,
    },
    timeout: 3600, // in seconds
    enableDuplicateRequests: false,
    executePathway: (context) => {
        const provider = process.env.TRANSCRIBE_PROVIDER || "openai";
        if (provider === "openai") return context.runAllPrompts(context.args);
        if (provider === "azure") {
            context.resolver.swapModel("oai-whisper-ts");
            return context.runAllPrompts(context.args);
        }
        if (provider === "replicate-whisper" || provider === "replicate-whisperx") {
            context.resolver.swapModel(provider);
            return executeReplicateTranscription(provider.replace("replicate-", ""), context);
        }
        throw new Error(`Unknown TRANSCRIBE_PROVIDER: ${provider}`);
    },
};
