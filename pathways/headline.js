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
    inputParameters: {
        seoOptimized: false,
        count: 5,        
    },
    list: true
}