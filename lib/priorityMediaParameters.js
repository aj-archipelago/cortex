// Shared public parameters for the metadata-driven Replicate media pathway.
// Keep these typed: Cortex uses this contract to build its GraphQL schema.
export const priorityMediaParameters = {
    background: { type: "string" },
    outputCompression: { type: "integer" },
    promptUpsampler: { type: "string" },
    draft: { type: "boolean" },
    autoAspectRatio: { type: "boolean" },
    webGrounding: { type: "boolean" },
    fps: { type: "integer" },
    generationMode: { type: "string" },
    watermark: { type: "boolean" },
    matchInputImage: { type: "boolean" },
    enablePromptExpansion: { type: "boolean" },
    layerDecomposition: { type: "boolean" },
    styleId: { type: "string" },
    styleMatch: { type: "string" },
    sourceUrl: { type: "string" },
    sourceLanguage: { type: "string" },
    targetLanguage: { type: "string" },
    cloningStrength: { type: "integer" },
};
