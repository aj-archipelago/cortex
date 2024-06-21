import { Prompt } from '../server/prompt.js';
import { PathwayResolver } from '../server/pathwayResolver.js';
import { callPathway } from '../lib/pathwayTools.js';

const getExamples = (style) => {
    switch (style) {
        case 'quote':
            return [`"Enough is enough": A UK union rep fighting from the picket line`,
                `"So trapped": A young Iraqi driver's costly taxi to nowhere`,
                `"Enduring commitment": Key takeaways from US-GCC joint statement`,
                `"Real good shape": Biden and Sunak hail ties at White House meet`,
            ];
        default:
            return [];
    }
}

export default {
    prompt: [],
    inputParameters: {
        count: 5,
        targetLength: 80,
        idea: '',
        style: '',
        keywords: ['']
    },
    list: true,
    model: 'oai-gpt4o',
    useInputChunking: false,
    enableDuplicateRequests: false,

    // Custom resolver to generate headlines by reprompting if they are too long
    resolver: async (_parent, args, contextValue, _info) => {
        const { config, pathway } = contextValue;
        let { targetLength = 80, count = 5 } = args;
        const MAX_ITERATIONS = 3;

        if (count === 0) {
            count = 5;
        }

        if (targetLength === 0) {
            targetLength = 80;
        }

        let targetWords = Math.round(targetLength / 7);
        let quotesInDocument = [];


        function getPathwayPrompt(args, count, targetWords) {
            const examples = getExamples(args.style);

            let keywordsPrompt = '';
            if (args.keywords?.length) {
                keywordsPrompt = `- Headline must include these keywords: ${args.keywords.map(k => `"${k}"`).join(', ')}\n`;
            }

            let anglePrompt = '';
            if (args.idea) {
                anglePrompt = `- Headline must align to this angle: {{idea}}\n`;
            }

            let examplesPrompt = '';
            if (examples?.length) {
                const { includedQuotes } = args;

                examplesPrompt = `- Headline must start with a short, impactful quote snippet taken verbatim from a quote in the news excerpt. (example format: "Enduring commitment": Key takeaways from US-GCC joint statement, "Real good shape": Biden and Sunak hail ties at White House meet).`;

                if (includedQuotes) {
                    examplesPrompt += `The snippet must be taken from one of the following quotes:\n    - ${includedQuotes.map(q => `"${q}"`).join('\n    - ')}\n`;
                }
                else {
                    examplesPrompt += `\n`;
                }
            }

            let instructionsPrompt = '';
            if (anglePrompt || keywordsPrompt || examplesPrompt) {
                instructionsPrompt = `${keywordsPrompt}${anglePrompt}${examplesPrompt}\n`;
            }

            const prompt = [
                new Prompt({
                    messages: [
                        { "role": "system", "content": `Assistant is a highly skilled multilingual headline writer for a prestigious international news agency. Assistant generates attention-grabbing, informative, and engaging headlines that capture the essence of the article while sparking curiosity in readers. When the user posts any text in any language, assistant will create ${ count * 2 } compelling headlines for that text in the same language as the text. Assistant will produce only a numbered list of headlines and no additional notes or commentary.\n\nAll headlines must comply with all of the following instructions:\n${ instructionsPrompt }\n- Headlines must be ${ targetWords } words or fewer.\n- Headlines must be written in sentence-case (only the first letter of the headline and proper nouns capitalized).\n` },
                        { "role": "user", "content": `{{{text}}}` }
                    ]
                }),
            ];
            return prompt;
        }

        function getQuotes(text) {

            const regex = /"([^"]*)"/g;
            let matches;

            text = text.replace(/“/g, '"').replace(/”/g, '"');
            // normalize single quotes
            text = text.replace(/‘/g, "'").replace(/’/g, "'");

            matches = text.matchAll(regex);

            let quotes = [];
            for (const match of matches) {
                quotes.push(match[1]);
            }

            return quotes;
        }

        const areQuotesInHeadlineValid = (headline) => {
            if (args.style === 'quote') {
                const quotesInHeadline = getQuotes(headline);
                const nonExactQuotes = [];

                for (const quote of quotesInHeadline) {
                    const exists = quotesInDocument.some(q => q.toLowerCase().includes(quote.toLowerCase()));
                    if (!exists) {
                        nonExactQuotes.push(quote);
                    }
                }

                if (nonExactQuotes.length) {
                    console.log(`Non-exact quotes: ${nonExactQuotes.join(', ')}`);
                }

                // Commented out to allow non-verbatim quotes and give the AI some flexibility
                // in adapting a quote to the headline
                // return nonExactQuotes.length === 0;
                return true;
            }
            else {
                return true;
            }
        }

        let pathwayResolver = new PathwayResolver({ config, pathway, args });

        if (args.style === 'quote') {
            // The AI seems to node include the initial quote in the word count for the headline.
            // Doing this to account for that.
            targetWords = targetWords - 3;
            quotesInDocument = await callPathway('quotes', { ...args, targetLength: 0 });
            args.includedQuotes = quotesInDocument;
        }

        pathwayResolver.pathwayPrompt = getPathwayPrompt(args, count, targetWords);
        let headlines = await pathwayResolver.resolve(args);

        // remove surrounding quotes from headlines
        headlines = headlines.map(h => h.replace(/^"(.*)"$/, '$1'));
        let shortHeadlines = headlines.filter(h => h.length < targetLength && areQuotesInHeadlineValid(h)).slice(0, count);
        let i = 0;

        // If some headlines do not meet the length requirement, reprompt
        while (shortHeadlines.length < count && i < MAX_ITERATIONS) {
            pathwayResolver.pathwayPrompt = getPathwayPrompt(args, count, targetWords);
            let headlines = await pathwayResolver.resolve(args);
            // remove surrounding quotes from headlines
            headlines = headlines.map(h => h.replace(/^"(.*)"$/, '$1'));
            shortHeadlines = shortHeadlines.concat(headlines.filter(h => h.length < targetLength && !shortHeadlines.includes(h) && areQuotesInHeadlineValid(h)).slice(0, count));
            i++;
        }

        return shortHeadlines.slice(0, count);
    }
}

