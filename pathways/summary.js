const { semanticTruncate } = require('../graphql/chunker');
const { PathwayResolver } = require('../graphql/pathwayResolver');

module.exports = {
    prompt: `{{{text}}}\n\nWrite a summary of the above text:\n\n`,

    inputParameters: {
        targetLength: 500,
    },
    resolver: async (parent, args, contextValue, info) => {
        const { config, pathway, requestState } = contextValue;
        const originalTargetLength = args.targetLength;
        const errorMargin = 0.2;
        const lowTargetLength = originalTargetLength * (1 - errorMargin);
        const targetWords = Math.round(originalTargetLength / 6.6);

        // if the text is shorter than the summary length, just return the text
        if (args.text.length <= originalTargetLength) {
            return args.text;
        }

        const MAX_ITERATIONS = 5;
        let summary = '';
        let bestSummary = '';
        let pathwayResolver = new PathwayResolver({ config, pathway, requestState });
        // modify the prompt to be words-based instead of characters-based
        pathwayResolver.pathwayPrompt = `{{{text}}}\n\nWrite a summary of the above text in exactly ${targetWords} words:\n\n`

        let i = 0;
        // reprompt if summary is too long or too short
        while (((summary.length > originalTargetLength) || (summary.length < lowTargetLength)) && i < MAX_ITERATIONS) {
            summary = await pathwayResolver.resolve(args);
            i++;
        }

        // if the summary is still too long, truncate it
        if (summary.length > originalTargetLength) {
            return semanticTruncate(summary, originalTargetLength);
        } else {
            return summary;
        }
    }
}
