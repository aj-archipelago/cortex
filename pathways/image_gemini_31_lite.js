import imageGemini31 from "./image_gemini_31.js";

const MODEL_ID = "gemini-flash-lite-31-image";

export default {
    ...imageGemini31,
    inputParameters: {
        ...imageGemini31.inputParameters,
    },
    executePathway: async (context) =>
        imageGemini31.executePathway({
            ...context,
            args: {
                ...context.args,
                model: MODEL_ID,
            },
        }),
    model: MODEL_ID,
};
