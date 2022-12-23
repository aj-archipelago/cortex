module.exports = {
    prompt: `{{text}}\n\nList the top {{count}} news categories for the above article (e.g. 1. Finance):`,
    parameters: {
        count: 5,
    },
    returnType: {
        name: "String",
        type: "list"
    }
}