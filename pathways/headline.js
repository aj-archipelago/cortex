const { PathwayResolver } = require('../graphql/pathwayResolver');
module.exports = {

    prompt: '',
    inputParameters: {
        seoOptimized: false,
        count: 5,        
    },
    list: true,
    usePreviousResult: true,
    model: 'azure-td3',
    resolver: async (parent, args, contextValue, info) => {
        const { config, pathway, requestState } = contextValue;
        const seoString = args.seoOptimized ? ' SEO-optimized ': ' '
        pathway.prompt = [
            //`{{{text}}}\n\nCopy the names of all people and places exactly from the document above to a list below:\n`,
            //`{{{previousResult}}}\n\nRespecting the above list of people and places, generate {{count}}${seoString}headlines for the news article below:\n\n{{{text}}}\n\nHeadlines:\n`,
            `{{{text}}}\n\nCreate a very short summary of this document making sure to list all people by name with their roles clearly defined in the summary. Do not infer or guess at any names or roles - only include those names and roles in the summary that appear directly in the document. Write the summary below:\n`,
            `{{{previousResult}}}\n\nCreate a single consistent summary from all of the summaries above without losing information:\n\n`,
            `{{{previousResult}}}\n\nFrom this article summary generate the {{count}} best possible${seoString}news headlines for the article in the fomat (number. text):\n\n` 
        ]

        let pathwayResolver = new PathwayResolver({ config, pathway });

        return await pathwayResolver.resolve(args, requestState);
    }

}