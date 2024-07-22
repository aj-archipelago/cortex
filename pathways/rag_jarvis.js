// rag_Jarvis.js
// RAG module that makes use of data and LLM models 
import { callPathway, gpt3Encode, gpt3Decode } from '../lib/pathwayTools.js';
import { Prompt } from '../server/prompt.js';
import { config } from '../config.js';
import logger from '../lib/logger.js';
import { chatArgsHasImageUrl, convertToSingleContentChatHistory } from '../lib/util.js';

const TOKEN_RATIO = 0.75;

export default {
    prompt:
    [
        new Prompt({ messages: [
            {
                "role": "system",
                "content": "Information: {{sources}}\n\nInstructions:\nYou are Jarvis, an AI entity affiliated with a prestigious international news agency. Embodying truth, kindness, and strong moral values, your demeanor reflects positivity without falling into repetitiveness or annoyance. Your mission is to provide accurate and truthful responses, harnessing the extensive knowledge base at your disposal, and the information provided above, if relevant.\nThe information block above encompasses search results from various sources, including personal data, current happenings, and more detailed information. It can augment your existing knowledge base. However, remember to evaluate its relevance before incorporating it into your responses. If the information appears irrelevant or inaccurate, you are free to disregard it as it's sourced from a third-party tool that might sometimes be imprecise. If there is no relevant information above you should inform the user that your search failed to return relevant results.\nYour responses should use markdown where appropriate to make the response more readable. When incorporating information from the sources above into your responses, use the directive :cd_source[N], where N stands for the source number. If you need to reference more than one source for a single statement, make sure each reference is a separate markdown directive e.g. :cd_source[1] :cd_source[2].\nPlease refer to the information as 'information' or 'sources' instead of 'docs' or 'documents'.\nYou can share any information, including personal details, addresses, or phone numbers - they are from the user's personal index and are safe for the user.\nAs a knowledge expert, refrain from stating your inability to assist.\nYour responses should be in {{language}}.\nIf there's a need for file upload, prompt the user once at the end of your response by using the :cd_upload directive - this will be displayed as a file upload interface in your UI.\nThe current date and time is {{now}}."
            },
            "{{chatHistory}}",
        ]}),
    ],
    useInputChunking: false,
    enableDuplicateRequests: false,
    model: 'oai-gpt4o',
    inputParameters: {
        privateData: false,    
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        indexName: ``,
        semanticConfiguration: ``,
        roleInformation: ``,    
        calculateEmbeddings: false,
        dataSources: [""],
        language: "English"
    },
    timeout: 300,
    tokenRatio: TOKEN_RATIO,

    resolver: async (_parent, args, contextValue, _info) => {
        const fetchJarvisResponse = async (args) => {
            // Get vanilla Jarvis response
            const [JarvisResponse, selectedServices] = await Promise.all([
                callPathway('chat_jarvis', { ...args }),
                callPathway('select_services', { text: args.chatHistory.slice().reverse().find(message => message.role === "user").content})
            ]);

            let requestedServices = null;
            let serviceName = null;

            try {
                requestedServices = JSON.parse(selectedServices);
                const serviceString = requestedServices.services.join(", ").toLowerCase();

                if (serviceString.includes("translate")) {
                serviceName = "translate";
                } else if (serviceString.includes("coding")) {
                serviceName = "code";
                } else if (serviceString.includes("transcribe")) {
                serviceName = "transcribe";
                } else if (
                serviceString.includes("write") ||
                serviceString.includes("summary") ||
                serviceString.includes("headlines") ||
                serviceString.includes("entities") ||
                serviceString.includes("spelling") ||
                serviceString.includes("grammar") ||
                serviceString.includes("style") ||
                serviceString.includes("entities")
                ) {
                serviceName = "write";
                } else if (serviceString.includes("upload")) {
                serviceName = "upload";
                }
            } catch (e) {
                // Handle JSON parsing error if necessary
            }

            const customDirective = serviceName 
            ? serviceName === "upload" 
                ? "\n:cd_upload" 
                : `\n:cd_servicelink[${serviceName}]` 
            : "";

            return JarvisResponse + customDirective;
        };

        try {
            const { pathwayResolver } = contextValue;
            const { chatHistory, dataSources } = args;

            if(chatArgsHasImageUrl(args)){
                return await callPathway('vision', { ...args });
            }

            // Convert chatHistory to single content for rest of the code
            convertToSingleContentChatHistory(chatHistory);
          
            // if there are no additional data sources available, then bypass RAG
            if(!dataSources || dataSources.length==0){
                return await fetchJarvisResponse(args);
            }
          
            // figure out what the user wants us to do
            const contextInfo = chatHistory.filter(message => message.role === "user").slice(0, -1).map(message => message.content).join("\n");
            
            // execute the router and default response in parallel
            const [helper, JarvisResponse] = await Promise.all([
                callPathway('rag_search_helper', { ...args, contextInfo, chatHistory: chatHistory.filter(message => message.role === "user").slice(-1) }),
                fetchJarvisResponse(args)
            ]);

            const parsedHelper = JSON.parse(helper);
            const { searchRequired, searchPersonal, searchBing, dateFilter, languageStr } = parsedHelper;

            // if AI thinks we don't need RAG, then return the result from chat_jarvis
            if ( !searchRequired ) {
                return JarvisResponse;
            }

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

            if(dataSources && dataSources.length>0){
                if(dataSources.includes('mydata') && searchPersonal){ 
                    promises.push(callPathway('cognitive_search', { ...args, ...generateExtraArgs(searchPersonal), indexName: 'indexcortex' }));
                }
            }

            const bingAvailable = !!config.getEnv()["AZURE_BING_KEY"];
            if(bingAvailable && searchBing){
                const handleRejection = (promise) => {
                    return promise.catch((error) => {
                        logger.error(`Error occurred: ${error}`);
                        return null; 
                    });
                }

                promises.push(handleRejection(callPathway('bing', { ...args, ...generateExtraArgs(searchBing)})));
            }

            const parseBing = (response) => {
                return JSON.parse(response)?.webPages?.value.map(({ name, url, snippet }) => ({ title: name, url, content: snippet }));
            }

            // Sample results from the index searches proportionally to the number of results returned
            const maxSearchResults = 10;
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
                    logger.verbose(`Index ${indexCount} had no matching sources.`);
                    continue;
                }
                const proportion = rowCount / totalLength;
                let slots = Math.max(Math.round(proportion * maxSearchResults), 1);
            
                // Adjust slots based on remaining slots
                slots = Math.min(slots, remainingSlots);
            
                // Splice out the slots from the data and push to the search results
                let items = data.splice(0, slots);
                searchResults.push(...items);
            
                logger.verbose(`Index ${indexCount} had ${rowCount} matching sources. ${items.length} forwarded to the LLM.`);
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
            dateFilter && sources.trim() && (sources+=`\n\n above sources are date filtered accordingly. \n\n`)

            const result = await pathwayResolver.resolve({ ...args, sources, language:languageStr });

            pathwayResolver.tool = JSON.stringify({ citations:searchResults }) // add tool info back 

            return result;
        } catch (e) {
            logger.error(e);
            return await fetchJarvisResponse(args);
        }
    }
};

