const { PathwayResolver } = require('../graphql/pathwayResolver');
const { semanticTruncate } = require('../graphql/parser');

module.exports = {
    prompt: `Write a short ({{targetLength}} character) summary of the following:\n\n{{text}}`,
    inputParameters: {
        targetLength: 100,        
    },
    resolver: async (parent, args, contextValue, info) => {
        const { config, pathway, requestState } = contextValue;

        let pathwayResolver = new PathwayResolver({ config, pathway });

        let summary = await pathwayResolver.resolve(args, requestState);
        let i = 0;
        const MAX_ITERATIONS = 3;

        // reprompt if summary is too long
        while (summary.length > args.targetLength && i < MAX_ITERATIONS) {
            if (i > 0) {
                pathwayResolver.pathwayPrompt = `Write a shorter ({{targetLength}} character) summary of the following text:\n\n{{text}}\n\n`;
            }
//            if (i == (MAX_ITERATIONS - 1)) {
//                pathway.prompt = `Write the shortest possible summary of the following text:\n\n{{text}}\n\n`;
//            }
            summary = await pathwayResolver.resolve({ ...args, text: summary }, requestState);
            i++;
        }  

        return semanticTruncate(summary, args.targetLength);
    }
}
