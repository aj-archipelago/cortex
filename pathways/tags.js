module.exports = {
    prompt: `{{text}}\n\nList the top {{count}} news tags for the above article (e.g. 1. Finance):`,
    inputParameters: {
        count: 5,
    },
    list: true,
    useInputSummarization: true,
}
