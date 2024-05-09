// topics.js
// News categories identification module
// This module exports a prompt that takes an input article text and identifies the top news categories for the article.

import { callPathway } from '../lib/pathwayTools.js';

export default {
    prompt: [],
    model: 'azure-turbo-chat',

    // Define input parameters for the prompt, such as the number of top news topics to identify and select.
    inputParameters: {
        count: 5,
        topics: '',
    },

    // Set 'list' to true to indicate that the output is expected to be a list.
    list: true,
    timeout: 240,

    // Custom resolver to find matching topics.
    resolver: async (parent, args, _contextValue, _info) => {
        return await callPathway('taxonomy', { ...args, taxonomyType: 'topic', taxonomyItems: args.topics });
    }
}
