module.exports = {
    // All parameters defined under "parameters" are available
    // to this prompt function as the argument
    prompt: parameters => {
        if (parameters.seoOptimized) {
            return `{{text}} \n\nGenerate {{count}} SEO-optimized headlines for the news article above in the format (number. text):`
        }
        else {
            return `{{text}} \n\nGenerate {{count}} headlines for the news article above in the format (number. text):`
        }
    },
    parameters: {
        // Short-hand definition of a parameter (name: default value)
        seoOptimized: false,
        count: {
            // This is the GraphQL type of the parameter
            type: "Int",
            // If a default value is provided, the parameter is optional
            default: 5,
        }
    },
    // Default return type is a string
    returnType: {
        name: "String",
        type: "list",
    },
}