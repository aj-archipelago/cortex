module.exports = {
    prompt: [`{{text}}\n\nList the top {{count}} news categories for the above article (e.g. 1. Finance):`,
            `{{previousContext}}\n\nPick the {{count}} most important news categories from the above:`
    ],
    inputParameters: {
        count: 5,
    },
    list: true,
    usePreviousContext: true
}