// Text summarization module with custom resolver for turbo models
// This module exports a prompt that takes an input text and generates a summary using a custom resolver.

// Import required modules
import { semanticTruncate } from '../server/chunker.js';
import { PathwayResolver } from '../server/pathwayResolver.js';
import { Prompt } from '../server/prompt.js';
import { callPathway } from '../lib/pathwayTools.js';

export default {
    // Define input parameters for the prompt, such as the target length of the summary.
    inputParameters: {
        targetLength: 0,
        targetLanguage: ''
    },

    model: 'oai-gpt4o',

    // Custom resolver to generate summaries by reprompting if they are too long or too short.
    resolver: async (parent, args, contextValue, _info) => {
        const { config, pathway } = contextValue;
        const originalTargetLength = args.targetLength || 0;
        const targetLanguage = args.targetLanguage || await callPathway('language', args);

        const targetLanguagePrompt = targetLanguage ? `language '${targetLanguage}'` : 'same language as the text being summarized';

        // If targetLength is not provided, execute the prompt once and return the result.
        if (originalTargetLength === 0) {
            let pathwayResolver = new PathwayResolver({ config, pathway, args });
            pathwayResolver.pathwayPrompt = [
                new Prompt({ messages: [
                {"role": "system", "content": `Assistant is a highly skilled multilingual AI writing agent that summarizes text. When the user posts any text in any language, assistant will create a detailed summary of that text. Assistant will produce only the summary text and no additional or other response. The summary must be in the ${targetLanguagePrompt}.`},
                {"role": "user", "content": "Text to summarize:\n{{{text}}}"}
                ]}),
            ];
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
        pathwayResolver.pathwayPrompt = [
            new Prompt({ messages: [
            {"role": "system", "content": `Assistant is a highly skilled multilingual AI writing agent that summarizes text. When the user posts any text in any language, assistant will create a detailed summary of that text. The summary should be ${targetWords} words long. Assistant will produce only the summary text and no additional or other response. The summary must be in the ${targetLanguagePrompt}.`},
            {"role": "user", "content": "Text to summarize:\n{{{text}}}"}
            ]}),
        ];

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
            pathwayResolver.pathwayPrompt = [
                new Prompt({ messages: [
                {"role": "system", "content": `Assistant is a highly skilled multilingual AI writing agent that summarizes text. When the user posts any text in any language, assistant will create a detailed summary of that text. The summary should be ${targetWords} words long. Assistant will produce only the summary text and no additional or other response.  The summary must be in the ${targetLanguagePrompt}.`},
                {"role": "user", "content": `Text to summarize:\n${summary}`}
                ]}),
            ];
            summary = await pathwayResolver.resolve(args);
            i++;

            // Now make sure it's not too long
            while ((summary.length > originalTargetLength) && i < MAX_ITERATIONS) {
                // add the summary response from the assistant to the prompt
                pathwayResolver.pathwayPrompt[0].messages.push({"role": "assistant", "content": summary});
                // add the next query to the prompt
                pathwayResolver.pathwayPrompt[0].messages.push({"role": "system", "content": `Is that less than ${targetWords} words long? If not, try again using a length of no more than ${targetWords} words.  Generate only the summary text and no apology or other response. The summary must be in the ${targetLanguagePrompt}.`});
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
}