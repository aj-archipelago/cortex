// sys_e_start_voice.js
// Beginning of the rag voice workflow for Jarvis
import { callPathway, say } from '../../../lib/pathwayTools.js';
import logger from '../../../lib/logger.js';
import { chatArgsHasImageUrl, convertToSingleContentChatHistory } from '../../../lib/util.js';
import entityConstants from './shared/sys_entity_constants.js';

const TOKEN_RATIO = 0.75;

export default {
    useInputChunking: false,
    enableDuplicateRequests: false,
    model: 'oai-gpt4o',
    emulateOpenAIChatModel: 'rag-start-voice',
    useSingleTokenStream: true,
    inputParameters: {
        privateData: false,    
        chatHistory: [{role: '', content: []}],
        contextId: '',
        indexName: '',
        semanticConfiguration: '',
        roleInformation: '',    
        calculateEmbeddings: false,
        language: "English",
        aiName: "Jarvis",
        aiMemorySelfModify: true,
        aiStyle: "OpenAI",
        title: ``,
        messages: [],
    },
    timeout: 300,
    tokenRatio: TOKEN_RATIO,
    entityConstants,

    executePathway: async ({args, resolver}) => {
        let title = null;

        args = {
            ...args,
            ...entityConstants
        };

        args.chatHistory = (args.messages || args.chatHistory).slice(-20);
        const pathwayResolver = resolver;

        const styleModel = args.aiStyle === "Anthropic" ? "claude-35-sonnet-vertex" : "oai-gpt4o";

        const fetchChatResponse = async (args) => {
            const [chatResponse, chatTitleResponse] = await Promise.all([
                callPathway('sys_generator_quick_voice', {...args, model: styleModel}, pathwayResolver),
                callPathway('chat_title', { ...args, text: args.chatHistory.map(message => message.content).join("\n"), stream: false}),
            ]);

            title = chatTitleResponse;

            return chatResponse;
        };

        const { chatHistory } = args;

        const visionContentPresent = chatArgsHasImageUrl(args);
        const multiModalChatHistory = JSON.parse(JSON.stringify(chatHistory));

        // Convert chatHistory to text only for rest of the code
        // after this chatHistory is no longer multi-modal
        convertToSingleContentChatHistory(chatHistory);
      
        // get the last user message to use as a context
        const contextInfo = chatHistory.filter(message => message.role === "user").slice(0, -1).map(message => message.content).join("\n");
        // create a mini chat history for the router pathways with the last 3 messages
        const miniChatHistory = chatHistory.slice(-3);

        try {
            // Execute the router options in parallel
            let promises = {
                searchRequiredResponse: callPathway('sys_router_search', { ...args, chatHistory: miniChatHistory, contextInfo, stream: false }),
                toolRequiredResponse: callPathway('sys_router_tool', { ...args, chatHistory: miniChatHistory, contextInfo, stream: false }),
            };

            const results = await Promise.all(Object.values(promises));

            // Here results will have the resolved values in the same order as Object.values(promises)
            // You can then map these results back into an object
            let response = {};
            Object.keys(promises).forEach((key, i) => {
                response[key] = results[i];
            });

            const { searchRequiredResponse, toolRequiredResponse } = response;
            const parsedSResponse = searchRequiredResponse ? JSON.parse(searchRequiredResponse) : {};
            const parsedEResponse = toolRequiredResponse ? JSON.parse(toolRequiredResponse) : {};
            const { searchRequired } = parsedSResponse;
            const { toolRequired, toolFunction } = parsedEResponse;
            logger.info(`searchRequired: ${searchRequired}, toolRequired: ${toolRequired}, toolFunction: ${toolFunction}`);

            if (args.aiMemorySelfModify) {
                callPathway('sys_memory_manager', { ...args, chatHistory: chatHistory.slice(-2), stream: false })    
                .catch(error => logger.error(error?.message || "Error in sys_memory_manager pathway"));
            }
            
            if (toolRequired) {
                switch (toolFunction.toLowerCase()) {
                    case "image":
                    case "video":
                    case "audio":
                    case "pdf":
                        if (visionContentPresent) {
                            await callPathway('sys_generator_video_vision_voice', { ...args, chatHistory: multiModalChatHistory, stream: true }, pathwayResolver);
                            pathwayResolver.tool = JSON.stringify({ search: false, title });
                            return "";
                        }
                        break;
                    case "code":
                    case "write":
                        if (toolRequired) {
                            await callPathway('sys_generator_expert_voice', { ...args, chatHistory: multiModalChatHistory, stream: true }, pathwayResolver);
                            pathwayResolver.tool = JSON.stringify({ search: false });
                            return "";
                        }
                        break;
                    default:
                        break;
                }
            }

            if (searchRequired) {
                await say(resolver.requestId, parsedSResponse.searchMessage || "One moment please.", 10);
                pathwayResolver.tool = JSON.stringify({ hideFromModel: true, search: true, title });
                await callPathway('sys_entity_continue', { ...args, stream: true, model: styleModel, generatorPathway: 'sys_generator_results_voice' }, pathwayResolver);
                return "";
            }


            const fetchChatResponsePromise = fetchChatResponse(args);
            await fetchChatResponsePromise;
            pathwayResolver.tool = JSON.stringify({ search: false, title });
            return "";

        } catch (e) {
            pathwayResolver.logError(e);
            const fetchChatResponsePromise = fetchChatResponse(args);
            await fetchChatResponsePromise;
            pathwayResolver.tool = JSON.stringify({ search: false, title });
            return "";
        }
    }
};



