// sys_generator_results.js
// entity module that makes use of data and LLM models to produce a response 
import { callPathway, gpt3Encode, gpt3Decode, say } from '../../../lib/pathwayTools.js';
import { Prompt } from '../../../server/prompt.js';
import logger from '../../../lib/logger.js';
import { config } from '../../../config.js';
import { convertToSingleContentChatHistory } from '../../../lib/util.js';

const TOKEN_RATIO = 1.0;

export default {
    prompt: [],
    useInputChunking: false,
    enableDuplicateRequests: false,
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
        dataSources: [""],
        model: 'oai-gpt4o',
    },
    timeout: 300,
    tokenRatio: TOKEN_RATIO,

    executePathway: async ({args, runAllPrompts, resolver}) => {

        const { chatHistory } = args;

        let pathwayResolver = resolver;

        const useMemory = args.useMemory || pathwayResolver.pathway.inputParameters.useMemory;
 
        pathwayResolver.pathwayPrompt = 
        [
            new Prompt({ messages: [
                {
                    "role": "system",
                    "content": `{{renderTemplate AI_CONVERSATION_HISTORY}}
{{renderTemplate AI_COMMON_INSTRUCTIONS}}
{{renderTemplate AI_DIRECTIVES}}
Instructions: Your mission is to analyze the provided conversation history and provide accurate and truthful responses from the extensive knowledge base at your disposal and the information sources provided below that are the results of your most recent search of the internet, newswires, published Al Jazeera articles, and personal documents and data. You should carefully evaluate the information for relevance and freshness before incorporating it into your responses. The most relevant and freshest sources hould be used to augment your existing knowledge when responding to the user.
If the user is asking about a file (PDF, CSV, Word Document, text, etc.), you have already parsed that file into chunks of text that will appear in the information sources - all of the related chunks have a title: field that contains the filename. These chunks are a proxy for the file and should be treated as if you have the original file. The user cannot provide you with the original file in any other format. Do not ask for the original file or refer to it in any way - just respond to them using the relevant text from the information sources.
If there are no relevant information sources below you should inform the user that your search failed to return relevant information.
{{^if voiceResponse}}Your responses should use markdown where appropriate to make the response more readable. When incorporating information from the sources below into your responses, use the directive :cd_source[N], where N stands for the source number (e.g. :cd_source[1]). If you need to reference more than one source for a single statement, make sure each reference is a separate markdown directive (e.g. :cd_source[1] :cd_source[2]).{{/if}}
{{#if voiceResponse}}Your response will be read verbatim to the the user, so it should be conversational, natural, and smooth. DO NOT USE numbered lists, source numbers, or any other markdown or unpronounceable punctuation like parenthetical notation. Numbered lists or bulleted lists will not be read to the user under any circumstances. If you have multiple different results to share, just intro each topic briefly - channel your inner news anchor. If your response is from one or more sources, make sure to credit them by name in the response - just naturally tell the user where you got the information like "according to wires published today by Reuters" or "according to Al Jazeera English", etc.{{/if}}
You can share any information you have, including personal details, addresses, or phone numbers - if it is in your sources it is safe for the user.
Here are the search strings used to find the information sources:
<SEARCH_STRINGS>\n{{{searchStrings}}}\n</SEARCH_STRINGS>\n
Here are the information sources that were found:
<INFORMATION_SOURCES>\n{{{sources}}}\n</INFORMATION_SOURCES>\n\n
{{renderTemplate AI_DATETIME}}`,
                },
                {"role": "user", "content": "Use your extensive knowledge and the information sources to provide a detailed, accurate, truthful response to the user's request{{^if voiceResponse}} citing the sources where relevant{{/if}}. If the user is being vague (\"this\", \"this article\", \"this document\", etc.), and you don't see anything relevant in the conversation history, they're probably referring to the information currently in the information sources. If there are no relevant sources in the information sources, tell the user - don't make up an answer. Don't start the response with an affirmative like \"Sure\" or \"Certainly\". {{#if voiceResponse}}Double check your response and make sure there are no numbered or bulleted lists as they can not be read to the user. Plain text only.{{/if}}"},
            ]}),
        ];

        function extractReferencedSources(text) {
            if (!text) return new Set();
            const regex = /:cd_source\[(\d+)\]/g;
            const matches = text.match(regex);
            if (!matches) return new Set();
            return new Set(matches.map(match => parseInt(match.match(/\d+/)[0])));
        }

        function pruneSearchResults(searchResults, referencedSources) {
            return searchResults.map((result, index) => 
                referencedSources.has(index + 1) ? result : null
            );
        }

        let timeoutId;

        // Convert chatHistory to single content for rest of the code
        const multiModalChatHistory = JSON.parse(JSON.stringify(chatHistory));
        convertToSingleContentChatHistory(chatHistory);       

        // figure out what the user wants us to do
        const contextInfo = args.chatHistory.filter(message => message.role === "user").slice(0, -1).map(message => message.content).join("\n");

        let fillerResponses = [];
        if (args.voiceResponse) {
            const voiceFillerStrings = await callPathway('sys_generator_voice_filler', { ...args, contextInfo, stream: false });
            try {
            fillerResponses = JSON.parse(voiceFillerStrings);
            } catch (e) {
                console.error("Error parsing voice filler responses", e);
            }
            if (fillerResponses.length === 0) {
                fillerResponses = ["Please wait a moment...", "I'm working on it...", "Just a bit longer..."];
            }
        }

        let fillerIndex = 0;

        const calculateFillerTimeout = (fillerIndex) => {
            const baseTimeout = 6500;
            const randomTimeout = Math.floor(Math.random() * ((fillerIndex + 1) * 1000));
            return baseTimeout + randomTimeout;
        }

        const sendFillerMessage = async () => {
            if (args.voiceResponse && Array.isArray(fillerResponses) && fillerResponses.length > 0) {
                const message = fillerResponses[fillerIndex % fillerResponses.length];
                await say(resolver.rootRequestId, message, 1);
                fillerIndex++;
                // Set next timeout with random interval
                timeoutId = setTimeout(sendFillerMessage, calculateFillerTimeout(fillerIndex));
            }
        };

        try {
            // Start the first timeout
            timeoutId = setTimeout(sendFillerMessage, calculateFillerTimeout(fillerIndex));
            
            // execute the router and default response in parallel
            const [helper] = await Promise.all([
                callPathway('sys_query_builder', { ...args, useMemory, contextInfo, stream: false })
            ]);

            logger.debug(`Search helper response: ${helper}`);
            const parsedHelper = JSON.parse(helper);
            const { searchAJA, searchAJE, searchWires, searchPersonal, searchBing, dateFilter, languageStr, titleOnly } = parsedHelper;

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
                    top: titleOnly ? 500 : 50,
                    titleOnly: titleOnly
                };
            }
            
            // Execute the index searches in parallel respecting the dataSources parameter
            const promises = [];
            const dataSources = args.dataSources || pathwayResolver.pathway.inputParameters.dataSources;
            const allowAllSources = !dataSources.length || (dataSources.length === 1 && dataSources[0] === "");

            if(searchPersonal && (allowAllSources || dataSources.includes('mydata'))){ 
                promises.push(callPathway('cognitive_search', { ...args, ...generateExtraArgs(searchPersonal), indexName: 'indexcortex', stream: false }));
            }

            if(searchAJA && (allowAllSources || dataSources.includes('aja'))){
                promises.push(callPathway('cognitive_search', { ...args, ...generateExtraArgs(searchAJA), indexName: 'indexucmsaja', stream: false }));
            }

            if(searchAJE && (allowAllSources || dataSources.includes('aje'))){
                promises.push(callPathway('cognitive_search', { ...args, ...generateExtraArgs(searchAJE), indexName: 'indexucmsaje', stream: false }));
            }

            if(searchWires && (allowAllSources || dataSources.includes('wires'))){
                promises.push(callPathway('cognitive_search', { ...args, ...generateExtraArgs(searchWires), indexName: 'indexwires', stream: false }));
            }

            const bingAvailable = !!config.getEnv()["AZURE_BING_KEY"];
            if(bingAvailable && searchBing && (allowAllSources || dataSources.includes('bing'))){
                const handleRejection = (promise) => {
                    return promise.catch((error) => {
                        logger.error(`Error occurred searching Bing: ${error}`);
                        return null; 
                    });
                }

                promises.push(handleRejection(callPathway('bing', { ...args, ...generateExtraArgs(searchBing), stream: false})));
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
            const maxSearchResults = titleOnly ? 500 : 50;
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

                if (content && !titleOnly) {
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
            dateFilter && sources.trim() && (sources+=`\n\nThe above sources are date filtered accordingly.`);

            let result;

            result = await runAllPrompts({ ...args, searchStrings: `${helper}`, sources, chatHistory: multiModalChatHistory, language:languageStr, stream: false });
            
            if (timeoutId) {
                clearTimeout(timeoutId);
            }

            if (args.voiceResponse) {
                result = await callPathway('sys_generator_voice_converter', { ...args, text: result, stream: false });
            }

            if (!args.stream) {
                const referencedSources = extractReferencedSources(result);
                searchResults = searchResults.length ? pruneSearchResults(searchResults, referencedSources) : [];
            }

            // Update the tool info with the pruned searchResults
            pathwayResolver.tool = JSON.stringify({ toolUsed: "search", citations: searchResults });

            return result;
        } catch (e) {
            const result = await callPathway('sys_generator_error', { ...args, text: JSON.stringify(e), stream: false });
            return result;
        } finally {
            // Clean up timeout when done
            if (timeoutId) {
                clearTimeout(timeoutId);
            }
        }
    }
};