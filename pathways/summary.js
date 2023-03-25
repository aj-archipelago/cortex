// summary.js
// Text summarization module with custom resolver
// This module exports a prompt that takes an input text and generates a summary using a custom resolver.

// Import required modules
const { semanticTruncate } = require('../graphql/chunker');
const { PathwayResolver } = require('../graphql/pathwayResolver');

module.exports = {
    // The main prompt function that takes the input text and asks to generate a summary.
    prompt: `{{{text}}}\n\nWrite a summary of the above text:\n\n`,

    // Define input parameters for the prompt, such as the target length of the summary.
    inputParameters: {
        targetLength: 0,
    },

    // Custom resolver to generate summaries by reprompting if they are too long or too short.
    resolver: async (parent, args, contextValue, info) => {
        const { config, pathway, requestState } = contextValue;
        const originalTargetLength = args.targetLength;

        // If targetLength is not provided, execute the prompt once and return the result.
        if (originalTargetLength === 0) {
            let pathwayResolver = new PathwayResolver({ config, pathway, requestState });
            return await pathwayResolver.resolve(args);
        }

        const errorMargin = 0.2;
        const lowTargetLength = originalTargetLength * (1 - errorMargin);
        const targetWords = Math.round(originalTargetLength / 6.6);

        // If the text is shorter than the summary length, just return the text.
        if (args.text.length <= originalTargetLength) {
            return args.text;
        }

        const MAX_ITERATIONS = 5;
        let summary = '';
        let pathwayResolver = new PathwayResolver({ config, pathway, requestState });

        
        // Modify the prompt to be words-based instead of characters-based.
        pathwayResolver.pathwayPrompt = `{{{text}}}\n\nWrite a summary of the above text in exactly ${targetWords} words:\n\n`

        let i = 0;
        // Reprompt if summary is too long or too short.
        while (((summary.length > originalTargetLength) || (summary.length < lowTargetLength)) && i < MAX_ITERATIONS) {
            summary = await pathwayResolver.resolve(args);
            i++;
        }

        // If the summary is still too long, truncate it.
        if (summary.length > originalTargetLength) {
            return semanticTruncate(summary, originalTargetLength);
        } else {
            return summary;
        }
    }
}