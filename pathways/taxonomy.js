// taxonomy.js
// News taxonomy identification module
// This module exports a prompt that takes an input article text and taxonomy list and type and identifies the top news taxonomy for the article.

import { Prompt } from "../server/prompt.js";
import { PathwayResolver } from '../server/pathwayResolver.js';
import { callPathway } from '../lib/pathwayTools.js';

function getFilteredTaxonomyItems(taxonomyResult, taxonomySet) {
    // Normalize taxonomy item
    function normalizeTaxonomyItem(item) {
        return item.trim().toLowerCase().replace(/[.,]/g, '');
    }

    const taxonomyItems = taxonomySet.split(',');
    const filteredTaxonomyResult = taxonomyResult.reduce((acc, item) => {
        const normalizedItem = normalizeTaxonomyItem(item);
        const matchingItemIndex = taxonomyItems
            .map(s => normalizeTaxonomyItem(s))
            .findIndex(normalizedPredefinedItem => normalizedPredefinedItem === normalizedItem);

        // If a matchingItemIndex is found, add the verbatim item from the predefined set
        if (matchingItemIndex !== -1) {
            acc.push(taxonomyItems[matchingItemIndex]);
        }

        return acc;
    }, []);

    // If filteredTaxonomyResult is not empty, push the members of filteredTaxonomyResult into taxonomyResults
    const taxonomyResults = [];
    if (filteredTaxonomyResult.length > 0) {
        taxonomyResults.push(...filteredTaxonomyResult);
    }
    
    return taxonomyResults;
}

export default {
    prompt: [],
    model: 'azure-turbo-chat',

    // Define input parameters for the prompt, such as the number of top news taxonomyItems to identify and select.
    inputParameters: {
        count: 5,
        taxonomyItems: '',
        taxonomyType: 'topic',
    },

    // Set 'list' to true to indicate that the output is expected to be a list.
    list: true,
    timeout: 240,

    // Custom resolver to find matching taxonomyItems.
    resolver: async (parent, args, contextValue, _info) => {
        const { config, pathway } = contextValue;
        const taxonomyItems = args.taxonomyItems;
        const taxonomyType = args.taxonomyType || 'topic';
        let text = args.text;

        // Summarize the input text
        text = await callPathway('summary', { ...args, targetLength: 0 });

        // loop through the comma delimited list of taxonomyItems and create sets of 25 or less
        // to pass into a call to the taxonomyItem picking logic
        const taxonomyItemsArray = taxonomyItems.split(',')
            .map(taxonomyItem => taxonomyItem.trim())
            .filter(taxonomyItem => taxonomyItem.length > 0);

        const taxonomyItemSets = taxonomyItemsArray.reduce((acc, taxonomyItem, index) => {
            if (index % 25 === 0) {
                acc.push(taxonomyItem);
            } else {
                acc[acc.length - 1] += `, ${taxonomyItem}`;
            }
            return acc;
        }, []);

        let pathwayResolver = new PathwayResolver({ config, pathway, args });

        // call the taxonomyItemging logic for each set of taxonomyItems
        const taxonomyItemResults = [];
        for (let taxonomyItemSet of taxonomyItemSets) {
            if (taxonomyItemSet.length === 0) continue;
            pathwayResolver.pathwayPrompt = [
                new Prompt({
                    messages: [
                        { "role": "system", "content": `Assistant is an AI editorial assistant for an online news agency tasked with identifying ${taxonomyType}s from a pre-determined list that fit a news article summary. When User posts a news article summary and a list of possible ${taxonomyType}s, assistant will carefully examine the ${taxonomyType}s in the list. If any of them are a high confidence match for the article, assistant will return the matching ${taxonomyType}s as a comma separated list. Assistant must only identify a ${taxonomyType} if assistant is sure the ${taxonomyType} is a good match for the article. Any ${taxonomyType}s that assistant returns must be in the list already - assistant cannot add new ${taxonomyType}s. If there are no good matches, assistant will respond with <none>. Assistant will return only the ${taxonomyType}s and no other notes or commentary.`},
                        { "role": "user", "content": `Article Summary: {{{text}}}\n\nPossible ${taxonomyType}s: ${taxonomyItemSet}\n\n`},
                    ]
                }),
            ];
    
            const taxonomyItemResult = await pathwayResolver.resolve({ ...args, text });

            taxonomyItemResults.push(...getFilteredTaxonomyItems(taxonomyItemResult, taxonomyItemSet));
        }
        
        if (taxonomyItemResults.length < 2) {
            return taxonomyItemResults;
        }

        if (args.count === 1) {
            pathwayResolver.pathwayPrompt = [
                new Prompt({
                    messages: [
                        { "role": "system", "content": `Assistant is an AI editorial assistant for an online news agency tasked with identifying a single ${taxonomyType} from a list that best fits a news article summary. When User posts a news article summary and a list of possible ${taxonomyType}s, assistant will carefully examine the ${taxonomyType}s in the list and return the one ${taxonomyType} that best represents the news article summary. Assistant will use high judgement when picking the correct ${taxonomyType}. Assistant will return only the ${taxonomyType} and no other notes or commentary.` },
                        { "role": "user", "content": `Article Summary: {{{text}}}\n\nPossible ${taxonomyType}s: ${taxonomyItemResults.join(', ')}\n\n`},
                    ]
                }),
            ];
        } else {
            pathwayResolver.pathwayPrompt = [
                new Prompt({
                    messages: [
                        { "role": "system", "content": `Assistant is an AI editorial assistant for an online news agency tasked with identifying ${taxonomyType}s from a list that best fit a news article summary. When User posts a news article summary and a list of possible ${taxonomyType}s, assistant will carefully examine the ${taxonomyType}s in the list and return them in order of relevance to the article summary (best fit first). Assistant will return only the list of ${taxonomyType}s and no other notes or commentary. Assistant will not add ${taxonomyType}s to the list and will select only from User's posted ${taxonomyType}s.` },
                        { "role": "user", "content": `Article Summary: {{{text}}}\n\nPossible ${taxonomyType}s: ${taxonomyItemResults.join(', ')}\n\n`},
                    ]
                }),
            ];
        }

        const taxonomyItemResult = await pathwayResolver.resolve({ ...args, text });

        taxonomyItemResults.length = 0;
        let filteredItems = getFilteredTaxonomyItems(taxonomyItemResult, taxonomyItems);
        if (args.count > 0) {
            filteredItems = filteredItems.slice(0, args.count);
        }
        taxonomyItemResults.push(...filteredItems);

        return taxonomyItemResults;

    }
}
