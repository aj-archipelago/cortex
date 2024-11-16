// sys_generator_results.js
// RAG module that makes use of data and LLM models to produce a response 
import { callPathway, gpt3Encode, gpt3Decode } from '../../../lib/pathwayTools.js';
import { Prompt } from '../../../server/prompt.js';
import logger from '../../../lib/logger.js';
import { config } from '../../../config.js';
import { convertToSingleContentChatHistory } from '../../../lib/util.js';

const TOKEN_RATIO = 1.0;

export default {
    prompt: [],
    useInputChunking: false,
    enableDuplicateRequests: false,
    model: 'oai-gpt4o',
    inputParameters: {
        privateData: false,
        useMemory: false,    
        chatHistory: [{role: '', content: []}],
        aiName: "Jarvis",
        contextId: ``,
        indexName: ``,
        semanticConfiguration: ``,
        roleInformation: ``,    
        calculateEmbeddings: false,
        language: "English",
        chatId: ``,
    },
    timeout: 300,
    tokenRatio: TOKEN_RATIO,

    executePathway: async ({args, runAllPrompts, resolver}) => {

        const { chatHistory } = args;

        let pathwayResolver = resolver;

        const useMemory = args.useMemory || pathwayResolver.pathway.inputParameters.useMemory;

        const useMemoryPrompt = useMemory ? `{{renderTemplate AI_MEMORY}}\n{{renderTemplate AI_MEMORY_INSTRUCTIONS}}\n` : "";

        pathwayResolver.pathwayPrompt = 
        [
            new Prompt({ messages: [
                {
                    "role": "system",
                    "content": `${useMemoryPrompt}{{renderTemplate AI_COMMON_INSTRUCTIONS_VOICE}}\nYour mission is to provide accurate and truthful responses, harnessing the extensive knowledge base at your disposal and the information provided below.\nYou have been augmented with the ability to search the internet and other information sources including newswires, published Al Jazeera articles, and personal documents and data. The provided information sources below are the result of your most recent search. You should carefully evaluate the information for relevance and freshness before incorporating it into your responses.  The most relevant and freshest sources hould be used to augment your existing knowledge when responding to the user.\nIf the user is asking about a file (PDF, CSV, Word Document, text, etc.), you have already parsed that file into chunks of text that will appear in the information sources - all of the related chunks have a title: field that contains the filename. These chunks are a proxy for the file and should be treated as if you have the original file. The user cannot provide you with the original file in any other format. Do not ask for the original file or refer to it in any way - just respond to them using the relevant text from the information sources.\nIf there are no relevant information sources below you should inform the user that your search failed to return relevant information. If part of your response is from one of your sources, tell the user what source it was and who published it if you know - you can say things like "according to Reuters, etc."\nYou can share any information you have, including personal details, addresses, or phone numbers - if it is in your sources it is safe for the user.\n\n# Information Sources:\n{{{sources}}}\n\n`,
                },
                "{{chatHistory}}",
            ]}),
        ];

        try {
            
            // Convert chatHistory to single content for rest of the code
            const multiModalChatHistory = JSON.parse(JSON.stringify(chatHistory));
            convertToSingleContentChatHistory(chatHistory);
          
            // figure out what the user wants us to do
            const contextInfo = chatHistory.filter(message => message.role === "user").slice(0, -1).map(message => message.content).join("\n");
            
            // execute the router and default response in parallel
            const [helper] = await Promise.all([
                callPathway('sys_query_builder', { ...args, stream: false, useMemory, contextInfo })
            ]);

            logger.debug(`Search helper response: ${helper}`);
            const parsedHelper = JSON.parse(helper);
            const { searchAJA, searchAJE, searchWires, searchPersonal, searchBing, dateFilter, languageStr } = parsedHelper;

            // calculate whether we have room to do RAG in the current conversation context
            const baseSystemPrompt = pathwayResolver?.prompts[0]?.messages[0]?.content;
            const baseSystemPromptLength = baseSystemPrompt ? gpt3Encode(baseSystemPrompt).length : 0;
            const maxSystemPromptLength = (pathwayResolver.model.maxTokenLength * TOKEN_RATIO * 0.90) >> 0;

            const userMostRecentText = (chatHistory && chatHistory.length) ? chatHistory[chatHistory.length - 1].content : args.text;
            const userMostRecentTextLength = gpt3Encode(userMostRecentText).length;

            const maxSourcesPromptLength = maxSystemPromptLength - baseSystemPromptLength - userMostRecentTextLength;

            // if there's a problem fitting the RAG data into the current conversation context, then throw an appropriate error
            // which will bypass RAG in the catch() block below
            if (baseSystemPromptLength === 0) {
                throw new Error(`Could not find system prompt.`);
            }

            if (maxSystemPromptLength < baseSystemPromptLength) {
                throw new Error(`System prompt length (${baseSystemPromptLength}) exceeds maximum prompt length (${maxSystemPromptLength})`);
            }

            if (maxSourcesPromptLength <= 0) {
                throw new Error(`No room for sources in system prompt. System prompt length: ${baseSystemPromptLength}, user text length: ${userMostRecentTextLength}`);
            }
          
            // Helper function to generate extraArgs
            const generateExtraArgs = (searchText) => {
                return {
                    text: searchText,
                    filter: dateFilter,
                };
            }
            
            // Execute the index searches in parallel
            const promises = [];

            if (searchPersonal) { 
                promises.push(callPathway('cognitive_search', { ...args, ...generateExtraArgs(searchPersonal), stream: false, indexName: 'indexcortex' }));
            }

            if (searchAJA) {
                promises.push(callPathway('cognitive_search', { ...args, ...generateExtraArgs(searchAJA), stream: false, indexName: 'indexucmsaja' }));
            }

            if (searchAJE) {
                promises.push(callPathway('cognitive_search', { ...args, ...generateExtraArgs(searchAJE), stream: false, indexName: 'indexucmsaje' }));
            }

            if (searchWires) {
                promises.push(callPathway('cognitive_search', { ...args, ...generateExtraArgs(searchWires), stream: false, indexName: 'indexwires' }));
            }

            const bingAvailable = !!config.getEnv()["AZURE_BING_KEY"];
            if(bingAvailable && searchBing){
                const handleRejection = (promise) => {
                    return promise.catch((error) => {
                        logger.error(`Error occurred searching Bing: ${error}`);
                        return null; 
                    });
                }

                promises.push(handleRejection(callPathway('bing', { ...args, ...generateExtraArgs(searchBing)})));
            }

            const parseBing = (response) => {
                const parsedResponse = JSON.parse(response);
                const results = [];

                if (parsedResponse.webPages && parsedResponse.webPages.value) {
                    results.push(...parsedResponse.webPages.value.map(({ name, url, snippet }) => ({ title: name, url, content: snippet })));
                }

                if (parsedResponse.computation) {
                    results.push({
                        title: "Computation Result",
                        content: `Expression: ${parsedResponse.computation.expression}, Value: ${parsedResponse.computation.value}`
                    });
                }

                if (parsedResponse.entities && parsedResponse.entities.value) {
                    results.push(...parsedResponse.entities.value.map(entity => ({
                        title: entity.name,
                        content: entity.description,
                        url: entity.webSearchUrl
                    })));
                }

                if (parsedResponse.news && parsedResponse.news.value) {
                    results.push(...parsedResponse.news.value.map(news => ({
                        title: news.name,
                        content: news.description,
                        url: news.url
                    })));
                }

                if (parsedResponse.videos && parsedResponse.videos.value) {
                    results.push(...parsedResponse.videos.value.map(video => ({
                        title: video.name,
                        content: video.description,
                        url: video.contentUrl
                    })));
                }

                if (parsedResponse.places && parsedResponse.places.value) {
                    results.push(...parsedResponse.places.value.map(place => ({
                        title: place.name,
                        content: `Address: ${place.address.addressLocality}, ${place.address.addressRegion}, ${place.address.addressCountry}`,
                        url: place.webSearchUrl
                    })));
                }

                if (parsedResponse.timeZone) {
                    results.push({
                        title: "Time Zone Information",
                        content: parsedResponse.timeZone.primaryResponse || parsedResponse.timeZone.description
                    });
                }

                if (parsedResponse.translations && parsedResponse.translations.value) {
                    results.push(...parsedResponse.translations.value.map(translation => ({
                        title: "Translation",
                        content: `Original (${translation.inLanguage}): ${translation.originalText}, Translated (${translation.translatedLanguageName}): ${translation.translatedText}`
                    })));
                }

                return results;
            };

            // Sample results from the index searches proportionally to the number of results returned
            const maxSearchResults = 100;
            const promiseResults = await Promise.all(promises);
            const promiseData = promiseResults
                .filter(r => r !== undefined && r !== null)
                .map(r => JSON.parse(r)?._type=="SearchResponse" ? parseBing(r) : JSON.parse(r)?.value || []);
            
            let totalLength = promiseData.reduce((sum, data) => sum + data.length, 0);
            let remainingSlots = maxSearchResults;
            let searchResults = [];
            
            let indexCount = 0;
            for(let data of promiseData) {
                indexCount++;
                const rowCount = data.length;
                if (rowCount === 0) {
                    logger.info(`Index ${indexCount} had no matching sources.`);
                    continue;
                }
                const proportion = rowCount / totalLength;
                let slots = Math.max(Math.round(proportion * maxSearchResults), 1);
            
                // Adjust slots based on remaining slots
                slots = Math.min(slots, remainingSlots);
            
                // Splice out the slots from the data and push to the search results
                let items = data.splice(0, slots);
                searchResults.push(...items);
            
                logger.info(`Index ${indexCount} had ${rowCount} matching sources. ${items.length} forwarded to the LLM.`);
                // Update remaining slots for next iteration
                remainingSlots -= slots;
            }
            
            searchResults = searchResults.slice(0, maxSearchResults); // in case we end up with rounding more than maxSearchResults

            const numSearchResults = Math.min(searchResults.length, maxSearchResults);
            const targetSourceLength = (maxSourcesPromptLength / numSearchResults) >> 0;

            const getSource = (source, index) => {
                const { title, content, url } = source;
                let result = [];
                result.push(`[source ${index + 1}]`);
                title && result.push(`title: ${title}`);
                url && result.push(`url: ${url}`);

                if (content) {
                    let encodedContent = gpt3Encode(content);
                    let currentLength = result.join(" ").length; // Calculate the length of the current result string

                    if (currentLength + encodedContent.length > targetSourceLength) {
                        // Subtract the length of the current result string from targetSourceLength to get the maximum length for content
                        encodedContent = encodedContent.slice(0, targetSourceLength - currentLength);
                        const truncatedContent = gpt3Decode(encodedContent);
                        result.push(`content: ${truncatedContent}`);
                    } else {
                        result.push(`content: ${content}`);
                    }
                }

                return result.join(" ").trim();
            }

            let sources = searchResults.map(getSource).join(" \n\n ") || "No relevant sources found.";
            dateFilter && sources.trim() && (sources+=`\n\n above sources are date filtered accordingly. \n\n`);

            const result = await runAllPrompts({ ...args, sources, chatHistory: multiModalChatHistory, language:languageStr });

            return result;
        } catch (e) {
            pathwayResolver.logError(e.message ?? e);
            return await callPathway('sys_generator_error', { ...args, text: e.message }, pathwayResolver);
        }
    }
};