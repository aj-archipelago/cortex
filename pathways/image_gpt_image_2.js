const inputImageSlots = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [
        i === 0 ? 'input_image' : `input_image_${i + 1}`,
        '',
    ]),
);

export default {
    prompt: ["{{text}}"],
    model: 'oai-gpt-image-2',
    timeout: 600,
    inputParameters: {
        text: "",
        size: "",
        quality: "",
        output_format: "",
        n: 1,
        mask: "",
        ...inputImageSlots,
    },
    executePathway: async ({ args, runAllPrompts }) => {
        const result = await runAllPrompts({ ...args });
        return typeof result === 'string' ? result : JSON.stringify(result);
    },
};
