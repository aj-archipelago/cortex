const { semanticTruncate } = require('../graphql/chunker');
const { PathwayResolver } = require('../graphql/pathwayResolver');

module.exports = {
    prompt: `{{{text}}}\n\nWrite a detailed summary of all of the text above, keeping the total summary length around {{targetLength}} characters:\n\n`,
    inputParameters: {
        targetLength: 500,        
    },
    resolver: async (parent, args, contextValue, info) => {
        const { config, pathway, requestState } = contextValue;
        const originalTargetLength = args.targetLength;
        const errorMargin = 0.2;
        const lowTargetLength = originalTargetLength * (1 - errorMargin);

        const MAX_ITERATIONS = 5;
        let summary = '';
        let bestSummary = '';
        let pathwayResolver = new PathwayResolver({ config, pathway });

        // reprompt if summary is too short
        let i = 0;
        while (summary.length < lowTargetLength && i < MAX_ITERATIONS) {
            summary = await pathwayResolver.resolve(args, requestState);
            if (summary.length > bestSummary.length) {
                bestSummary = summary;
            }
            i++;
        }

        summary = bestSummary;

        i = 0;
        // reprompt if summary is too long or too short
        while (((bestSummary.length > originalTargetLength) || (bestSummary.length < lowTargetLength)) && i < MAX_ITERATIONS) {
            pathwayResolver.pathwayPrompt = `{{{text}}}\n\nWrite a slightly shorter summary of the above:\n\n`;
            bestSummary = await pathwayResolver.resolve({ ...args, text: summary }, requestState);
            // if the summary that came back is still longer than the target, use it
            // otherwise, use the previous summary
            if (bestSummary.length > originalTargetLength) {
                summary = bestSummary;
            }
            i++;
        }  

        return semanticTruncate(bestSummary, originalTargetLength);
    }
}
