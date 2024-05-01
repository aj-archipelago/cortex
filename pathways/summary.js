// summary.js
// Text summarization module with custom resolver
// This module exports a prompt that takes an input text and generates a summary using a custom resolver.

// Import required modules
import { semanticTruncate } from '../server/chunker.js';
import { PathwayResolver } from '../server/pathwayResolver.js';

export default {
    // The main prompt function that takes the input text and asks to generate a summary.
    prompt: `{{{text}}}\n\nWrite a summary of the above text. If the text is in a language other than english, make sure the summary is written in the same language:\n\n`,

    // Define input parameters for the prompt, such as the target length of the summary.
    inputParameters: {
        targetLength: 0,
    },

    // Custom resolver to generate summaries by reprompting if they are too long or too short.
    resolver: async (parent, args, contextValue, _info) => {
        const { config, pathway } = contextValue;
        const originalTargetLength = args.targetLength;

        // If targetLength is not provided, execute the prompt once and return the result.
        if (!originalTargetLength) {
            let pathwayResolver = new PathwayResolver({ config, pathway, args });
            return await pathwayResolver.resolve(args);
        }

        const errorMargin = 0.1;
        const lowTargetLength = originalTargetLength * (1 - errorMargin);
        const targetWords = Math.round(originalTargetLength / 6.6);

        // If the text is shorter than the summary length, just return the text.
        if (args.text.length <= originalTargetLength) {
            return args.text;
        }

        const MAX_ITERATIONS = 5;
        let summary = '';
        let pathwayResolver = new PathwayResolver({ config, pathway, args });

        // Modify the prompt to be words-based instead of characters-based.
        pathwayResolver.pathwayPrompt = `Write a summary of all of the text below. If the text is in a language other than english, make sure the summary is written in the same language. Your summary should be ${targetWords} words in length.\n\nText:\n\n{{{text}}}\n\nSummary:\n\n`

        let i = 0;
        // Make sure it's long enough to start
        while ((summary.length < lowTargetLength) && i < MAX_ITERATIONS) {
            summary = await pathwayResolver.resolve(args);
            i++;
        }

        // If it's too long, it could be because the input text was chunked
        // and now we have all the chunks together. We can summarize that
        // to get a comprehensive summary.
        if (summary.length > originalTargetLength) {
            pathwayResolver.pathwayPrompt = `Write a summary of all of the text below. If the text is in a language other than english, make sure the summary is written in the same language. Your summary should be ${targetWords} words in length.\n\nText:\n\n${summary}\n\nSummary:\n\n`
            summary = await pathwayResolver.resolve(args);
            i++;

            // Now make sure it's not too long
            while ((summary.length > originalTargetLength) && i < MAX_ITERATIONS) {
                pathwayResolver.pathwayPrompt = `${summary}\n\nIs that less than ${targetWords} words long? If not, try again using a length of no more than ${targetWords} words.\n\n`;
                summary = await pathwayResolver.resolve(args);
                i++;
            }
        }

        // If the summary is still too long, truncate it.
        if (summary.length > originalTargetLength) {
            return semanticTruncate(summary, originalTargetLength);
        } else {
            return summary;
        }
    }
};


