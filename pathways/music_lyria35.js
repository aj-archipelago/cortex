import lyria from "./music_lyria.js";

export default {
    ...lyria,
    model: "google-lyria-3.5-music",
    inputParameters: { ...lyria.inputParameters, audioFormat: { type: "string" } },
};
