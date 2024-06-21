import { Prompt } from '../server/prompt.js';
import { PathwayResolver } from '../server/pathwayResolver.js';

export default {
    prompt: [],
    inputParameters: {
        count: 5,
        targetLength: 120,
        headline: '',
    },
    list: true,
    model: 'oai-gpt4o',
    useInputChunking: false,

    // Custom resolver to generate subheads by reprompting if they are too long
    resolver: async (_parent, args, contextValue, _info) => {
        const { config, pathway } = contextValue;
        let targetLength = args.targetLength || 120;
        let count = args.count || 5;
        
        const targetWords = Math.round(targetLength / 6);
        const MAX_ITERATIONS = 3;

        let pathwayResolver = new PathwayResolver({ config, pathway, args });

        pathwayResolver.pathwayPrompt = [
            new Prompt({
                messages: [
                    { "role": "system", "content": `Assistant is a highly skilled multilingual writer for a prestigious international news agency. Assistant generates descriptive, informative, and engaging subheadings that are consistent with and continue the flow of the headline for the article. When the user posts a headline and an article excerpt in any language, assistant will create ${ count * 2 } subheadings for that headline in the same language as the headline. Assistant will produce only a numbered list of subheadings and no additional notes or commentary.\n\nAll subheadings must comply with all of the following instructions:\n- Subheadings must not be enclosed in quotation marks\n- Subheadings must be ${ targetWords } words or fewer.\n- Subheadings must be written in sentence-case (only the first letter of the headline and proper nouns capitalized).\n` },
                    { "role": "user", "content": `Headline: {{{headline}}}\nArticle Excerpt:\n{{{text}}}` }
                ]
            }),
        ];

        let subheads = await pathwayResolver.resolve(args);
        let shortSubheads = subheads.filter(h => h.length > 80 && h.length < targetLength).slice(0, count);
        let i = 0;

        // if some subheads do not meet the length requirement, reprompt
        while (shortSubheads.length < count && i < MAX_ITERATIONS) {
            let subheads = await pathwayResolver.resolve(args);
            shortSubheads = subheads.filter(h => h.length > 80 && h.length < targetLength).slice(0, count);
            i++;
        }

        return shortSubheads;
    }
}