// locations.js
// News categories identification module
// This module exports a prompt that takes an input article text and identifies the top news categories for the article.

import { Prompt } from "../server/prompt.js";
import { PathwayResolver } from '../server/pathwayResolver.js';
import { callPathway } from '../lib/pathwayTools.js';

export default {
    prompt: [],
    model: 'oai-gpt4o',

    // Define input parameters for the prompt, such as the number of top news locations to identify and select.
    inputParameters: {
        count: 5,
        locations: '',
    },

    // Set 'list' to true to indicate that the output is expected to be a list.
    list: true,
    timeout: 240,

    // Custom resolver to find matching locations.
    resolver: async (parent, args, contextValue, _info) => {
        const { config, pathway } = contextValue;
        const locations = args.locations;
        let text = args.text;

        // Summarize the input text
        text = await callPathway('summary', { ...args, targetLength: 0 });

        // loop through the comma delimited list of locations and create sets of 25 or less
        // to pass into a call to the location picking logic
        const locationsArray = locations.split(',')
            .map(location => location.trim())
            .filter(location => location.length > 0);

        const locationSets = locationsArray.reduce((acc, location, index) => {
            if (index % 25 === 0) {
                acc.push(location);
            } else {
                acc[acc.length - 1] += `, ${location}`;
            }
            return acc;
        }, []);

        let pathwayResolver = new PathwayResolver({ config, pathway, args });

        // call the locationging logic for each set of locations
        const locationResults = [];
        for (let locationSet of locationSets) {
            if (locationSet.length === 0) continue;
            pathwayResolver.pathwayPrompt = [
                new Prompt({
                    messages: [
                        { "role": "system", "content": "Assistant is an AI editorial assistant for an online news agency tasked with identifying locations from a pre-determined list that fit a news article summary. When User posts a news article summary and a list of possible locations, assistant will carefully examine the locations in the list. If any of them are a high confidence match for the article, assistant will return the matching locations as a comma separated list. Assistant must only identify a location if assistant is sure the location is a good match for the article. Any locations that assistant returns must be in the list already - assistant cannot add new locations. If there are no good matches, assistant will respond with <none>." },
                        { "role": "user", "content": `Article Summary:\n\n{{{text}}}\n\nPossible locations: ${locationSet}`},
                    ]
                }),
            ];
    
            const locationResult = await pathwayResolver.resolve({ ...args, text });

            // Filter locationResult based on case-insensitive matches with locationSet
            const normalizelocation = (location) => {
                return location.trim().toLowerCase().replace(/[.,]/g, '');
            }
            
            const filteredlocationResult = locationResult.reduce((acc, location) => {
                const normalizedlocation = normalizelocation(location);
                const matchinglocation = locationSet.split(',')
                    .map(s => normalizelocation(s))
                    .findIndex(normalizedPredefinedlocation => normalizedPredefinedlocation === normalizedlocation);
            
                // If a matchinglocation is found, add the verbatim location from the predefined set
                if (matchinglocation !== -1) {
                    acc.push(locationSet.split(',')[matchinglocation]);
                }
            
                return acc;
            }, []);
            
            // If filteredlocationResult is not empty, push the members of filteredlocationResult into locationResults
            if (filteredlocationResult.length > 0) {
                locationResults.push(...filteredlocationResult);
            }
        }
        
        // Join the locationResults array with a comma separator
        return locationResults;

    }
}
