// tags.js
// News tags identification module
// This module exports a prompt that takes an input article text and identifies the top news tags for the article.

import { callPathway } from '../lib/pathwayTools.js';

export default {
    prompt: [],
    model: 'oai-gpt4o',

    // Define input parameters for the prompt, such as the number of top news tags to identify and select.
    inputParameters: {
        count: 5,
        tags: '',
    },

    // Set 'list' to true to indicate that the output is expected to be a list.
    list: true,
    timeout: 240,
    temperature: 0,

    resolver: async (parent, args, _contextValue, _info) => {
        return await callPathway('taxonomy', { ...args, taxonomyType: 'tag', taxonomyItems: args.tags });
    }
}