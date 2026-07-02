export default {
    prompt: ["{{{text}}}"],

    enableDuplicateRequests: false,
    inputParameters: {
        model: "replicate-dreamactor-m2.0",
        image: "",
        video: "",
        cut_first_second: true,
    },

    timeout: 60 * 30, // 30 minutes
};
