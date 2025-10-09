// bing_afagent.js
// Web search tool

import { config } from '../config.js';
import logger from '../lib/logger.js';

export default {
    prompt: ["{{text}}"],
    inputParameters: {
        text: ``,
        tool_choice: 'auto',
        count: 25,
        freshness: 'week',
        market: 'en-us',
        set_lang: 'en'
    },
    timeout: 400,
    enableDuplicateRequests: false,
    model: 'azure-bing-agent',
    useInputChunking: false,
    instructions: `You are a Bing search agent responding to user queries.

Instructions:
- CRITICAL: Always use your search tools and perform Bing searches before answering
- Retrieve only the most recent, credible, and relevant results using strict date filters.
- Exclude or explicitly tag outdated, speculative, forum, sponsored, or low-quality sources (e.g., Reddit, Quora, clickbait sites).
- Prioritize accuracy, factual precision, and clarity. Deduplicate similar results; show only unique, high-value sources.

Response Format:
- Precise citations are critical - make sure that each topic has a separate paragraph in your response and that each paragraph has direct citations
- Return the original search results with titles/snippets and direct citations only.
- Do not include notes, explanations, questions, commentary or any additional output.

Your only task is to deliver up-to-date, authoritative, and concise results — nothing else.`,
    parallel_tool_calls: true,

    executePathway: async ({args, runAllPrompts, resolver}) => {
        // Build dynamic tools configuration based on input parameters
        const azureFoundryBingSearchConnectionId = config.get('azureFoundryBingSearchConnectionId');
        if (azureFoundryBingSearchConnectionId) {

            const tools = [
                {
                    type: "bing_grounding",
                    bing_grounding: {
                        search_configurations: [
                            {
                                connection_id: config.get('azureFoundryBingSearchConnectionId'),
                                count: args.count || 25,
                                freshness: args.freshness || 'week',
                                market: args.market || 'en-us',
                                set_lang: args.set_lang || 'en'
                            }
                        ]
                    }                
                }
            ];

            // Add tools to the pathway configuration for this execution
            resolver.pathway.tools = tools;
        }

        // Run the standard pathway execution
        return await runAllPrompts(args);
    }
};

