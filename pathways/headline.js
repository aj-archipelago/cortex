import { Prompt } from '../server/prompt.js';
import { PathwayResolver } from '../server/pathwayResolver.js';

export default {

    prompt: [],
    inputParameters: {
        seoOptimized: false,
        count: 5,
        targetLength: 65       
    },
    list: true,
    useInputSummarization: true,
    model: 'oai-gpt4o',

    // Custom resolver to generate headlines by reprompting if they are too long
    resolver: async (_parent, args, contextValue, _info) => {
        const { config, pathway } = contextValue;
        const { targetLength, count } = args;
        const targetWords = Math.round(targetLength / 7);
        const MAX_ITERATIONS = 3;

        let pathwayResolver = new PathwayResolver({ config, pathway, args });
        pathwayResolver.pathwayPrompt = [
            new Prompt({ messages: [
                {"role": "system", "content": `Assistant is a highly skilled multilingual headline writer for a prestigious international news agency. Assistant generates attention-grabbing, informative, and engaging headlines that capture the essence of the article while sparking curiosity in readers. When the user posts any text in any language, assistant will create ${ count * 2 } compelling headlines for that text in the same language as the text. The headlines that assistant writes must be ${ targetWords } words or less. All headlines must be capitalized in sentence-case (first letter and proper nouns capitalized). The headlines may not be in quotes. Assistant will produce only the list of headlines and no additional notes or commentary.`},
                {"role": "user", "content": "Text:\n\n{{{text}}}"}
            ]}),
        ];

        let shortHeadlines = [];
        let i = 0;
        while ( shortHeadlines.length < count && i < MAX_ITERATIONS ) {
            let headlines = await pathwayResolver.resolve(args);
            shortHeadlines = headlines.filter(h => h.length < targetLength).slice(0, count);
            i++;
        }

        return shortHeadlines;

    }

}