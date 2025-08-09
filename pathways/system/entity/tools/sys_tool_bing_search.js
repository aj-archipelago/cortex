// sys_tool_bing_search.js
// Tool pathway that handles Bing web search functionality
import { callPathway } from '../../../../lib/pathwayTools.js';
import logger from '../../../../lib/logger.js';
import { config } from '../../../../config.js';
import { getSearchResultId } from '../../../../lib/util.js';

export default {
    prompt: [],
    timeout: 300,
    toolDefinition: { 
        type: "function",
        icon: "🌐",
        function: {
            name: "SearchInternet",
            description: "This tool allows you to use the Bing search api to search the internet and more. Use this for current events, news, fact-checking, and information requiring citation.",
            parameters: {
                type: "object",
                properties: {
                    q: {
                        type: "string",
                        description: "The complete query to pass to Azure Bing search using Bing's search syntax."
                    },
                    freshness: {
                        type: "string",
                        description: "Filter results by freshness (when the content was first encountered by the search engine). Only use this if you need to be very specific as it may exclude many relevant results. Can be 'day', 'week', 'month', or a date range 'YYYY-MM-DD..YYYY-MM-DD'"
                    },
                    count: {
                        type: "integer",
                        description: "Number of webpages to return (default is 10)"
                    },
                    safeSearch: {
                        type: "string",
                        description: "Filter adult content. Can be 'Off', 'Moderate' (default), or 'Strict'"
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    }
                },
                required: ["q", "userMessage"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {

        // Check if Bing API key is available
        const bingAvailable = !!config.getEnv()["AZURE_BING_KEY"];
        if (!bingAvailable) {
            throw new Error("Bing search is not available - missing API key");
        }

        try {
            // Call the Bing search pathway
            const response = await callPathway('bing', { 
                ...args
            }, resolver);

            if (resolver.errors && resolver.errors.length > 0) {
                const errorMessages = Array.isArray(resolver.errors) 
                    ? resolver.errors.map(err => err.message || err)
                    : [resolver.errors.message || resolver.errors];
                return JSON.stringify({ _type: "SearchError", value: errorMessages, recoveryMessage: "This tool failed. You should try the backup tool for this function." });
            }

            const parsedResponse = JSON.parse(response);
            const results = [];

            // Process web pages
            if (parsedResponse.webPages && parsedResponse.webPages.value) {
                results.push(...parsedResponse.webPages.value.map(({ name, url, snippet }) => ({
                    searchResultId: getSearchResultId(),
                    title: name,
                    url,
                    content: snippet
                })));
            }

            // Process computation results
            if (parsedResponse.computation) {
                results.push({
                    searchResultId: getSearchResultId(),
                    title: "Computation Result",
                    content: `Expression: ${parsedResponse.computation.expression}, Value: ${parsedResponse.computation.value}`
                });
            }

            // Process entities
            if (parsedResponse.entities && parsedResponse.entities.value) {
                results.push(...parsedResponse.entities.value.map(entity => ({
                    searchResultId: getSearchResultId(),
                    title: entity.name,
                    content: entity.description,
                    url: entity.webSearchUrl
                })));
            }

            // Process news
            if (parsedResponse.news && parsedResponse.news.value) {
                results.push(...parsedResponse.news.value.map(news => ({
                    searchResultId: getSearchResultId(),
                    title: news.name,
                    content: news.description,
                    url: news.url
                })));
            }

            // Process videos
            if (parsedResponse.videos && parsedResponse.videos.value) {
                results.push(...parsedResponse.videos.value.map(video => ({
                    searchResultId: getSearchResultId(),
                    title: video.name,
                    content: video.description,
                    url: video.contentUrl
                })));
            }

            // Process places
            if (parsedResponse.places && parsedResponse.places.value) {
                results.push(...parsedResponse.places.value.map(place => ({
                    searchResultId: getSearchResultId(),
                    title: place.name,
                    content: `Address: ${place.address.addressLocality}, ${place.address.addressRegion}, ${place.address.addressCountry}`,
                    url: place.webSearchUrl
                })));
            }

            // Process time zone
            if (parsedResponse.timeZone) {
                results.push({
                    searchResultId: getSearchResultId(),
                    title: "Time Zone Information",
                    content: parsedResponse.timeZone.primaryResponse || parsedResponse.timeZone.description
                });
            }

            // Process translations
            if (parsedResponse.translations && parsedResponse.translations.value) {
                results.push(...parsedResponse.translations.value.map(translation => ({
                    searchResultId: getSearchResultId(),
                    title: "Translation",
                    content: `Original (${translation.inLanguage}): ${translation.originalText}, Translated (${translation.translatedLanguageName}): ${translation.translatedText}`
                })));
            }

            resolver.tool = JSON.stringify({ toolUsed: "Search" });
            return JSON.stringify({ _type: "SearchResponse", value: results });
        } catch (e) {
            logger.error(`Error in Bing search: ${e}`);
            throw e;
        }
    }
}; 