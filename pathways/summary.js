const { semanticTruncate } = require('../graphql/chunker');
const { PathwayResolver } = require('../graphql/pathwayResolver');

module.exports = {
    prompt: `{{{text}}}\n\nWrite a short ({{targetLength}} character) summary of all of the text above:\n\n`,
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
                pathwayResolver.pathwayPrompt = `{{{text}}}\n\nWrite a shorter ({{targetLength}} character) summary of all of the text above:\n\n`;
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
