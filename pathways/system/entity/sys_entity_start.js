// sys_entity_start.js
// Beginning of the rag workflow for Jarvis
import { callPathway } from '../../../lib/pathwayTools.js';
import logger from  '../../../lib/logger.js';
import { chatArgsHasImageUrl, convertToSingleContentChatHistory } from  '../../../lib/util.js';
import { QueueServiceClient } from '@azure/storage-queue';
import entityConstants from './shared/sys_entity_constants.js';

const TOKEN_RATIO = 0.75;

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
let queueClient;

if (connectionString) {
  const queueName = process.env.AUTOGEN_MESSAGE_QUEUE || "autogen-message-queue";
  const queueClientService = QueueServiceClient.fromConnectionString(connectionString);
  queueClient = queueClientService.getQueueClient(queueName);
} else {
  logger.warn("Azure Storage connection string is not provided. Queue operations will be unavailable.");
}

async function sendMessageToQueue(data) {
    try {
        if(!queueClient){
            logger.warn("Azure Storage connection string is not provided. Queue operations will be unavailable.");
            return;
        }
        const encodedMessage = Buffer.from(JSON.stringify(data)).toString('base64');
        const result = await queueClient.sendMessage(encodedMessage);
        logger.info(`Message added to queue: ${JSON.stringify(result)}`);
        return result.messageId;
    } catch (error) {
        logger.error("Error sending message:", error);
    }
}

export default {
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
        dataSources: ["mydata", "aja", "aje", "wires", "bing"],
        language: "English",
        aiName: "Jarvis",
        aiMemorySelfModify: true,
        aiStyle: "OpenAI",
        title: ``,
    },
    timeout: 600,
    tokenRatio: TOKEN_RATIO,
    ...entityConstants,

    resolver: async (_parent, args, contextValue, _info) => {
        let title = null; // chat_title response, contains possible update to chat title
        let codeRequestId = null;
        args = { ...args, ...entityConstants };
        
        const { pathwayResolver } = contextValue;
        
        // if the model has been overridden, make sure to use it
        if (pathwayResolver.modelName) {
            args.model = pathwayResolver.modelName;
        }
        
        const fetchChatResponse = async (args) => {

            const styleModel = args.aiStyle === "Anthropic" ? "claude-35-sonnet-vertex" : "oai-gpt4o";

            const [chatResponse, chatTitleResponse] = await Promise.all([
                callPathway('sys_generator_quick', {...args, model: styleModel}),
                callPathway('chat_title', { ...args, text: args.chatHistory.map(message => message.content).join("\n")}),
            ]);

            title = chatTitleResponse;

            return chatResponse;
        };
            
        const { chatHistory } = args;
        const visionContentPresent = chatArgsHasImageUrl(args);
        //const multiModalChatHistory = JSON.parse(JSON.stringify(chatHistory));

        // Convert chatHistory to text only for rest of the code
        // after this chatHistory is no longer multi-modal
        convertToSingleContentChatHistory(chatHistory);
      
        // get the last user message to use as a context
        const contextInfo = chatHistory.filter(message => message.role === "user").slice(0, -1).map(message => message.content).join("\n");
        
        // start fetching the default response - we may need it later
        const fetchChatResponsePromise = fetchChatResponse(args);

        try {
            // Execute the router options in parallel
            let promises = {
                searchRequiredResponse: callPathway('sys_router_search', { ...args, contextInfo }),
                toolRequiredResponse: callPathway('sys_router_expert', { ...args, contextInfo }),
            };

            const results = await Promise.all(Object.values(promises));

            // Here results will have the resolved values in the same order as Object.values(promises)
            // You can then map these results back into an object
            let response = {};
            Object.keys(promises).forEach((key, i) => {
                response[key] = results[i];
            });

            const { searchRequiredResponse, toolRequiredResponse } = response;

            // Asynchronously manage memory for this context
            if (args.aiMemorySelfModify) {
                callPathway('sys_memory_manager', {  ...args })    
                .catch(error => logger.error(error?.message || "Error in sys_memory_manager pathway"));
            }

            const parsedSResponse = searchRequiredResponse ? JSON.parse(searchRequiredResponse) : {};
            const parsedEResponse = toolRequiredResponse ? JSON.parse(toolRequiredResponse) : {};
            const { searchRequired } = parsedSResponse;
            const { toolRequired, toolMessage, toolFunction } = parsedEResponse;
            let toolCallbackName = null;
            let toolCallbackId = null;
            let toolCallbackMessage = null;

            logger.info(`searchRequired: ${searchRequired}, toolRequired: ${toolRequired}, toolFunction: ${toolFunction}`);

            if (toolRequired && toolFunction) {
                switch (toolFunction.toLowerCase()) {
                    case "codeexecution":
                        {
                            const codingRequiredResponse = await callPathway('sys_router_code', { ...args, contextInfo });
                            let parsedCodingRequiredResponse;
                            try {
                                parsedCodingRequiredResponse = JSON.parse(codingRequiredResponse || "{}");
                            } catch (error) {
                                logger.error(`Error parsing codingRequiredResponse: ${error.message}, codingRequiredResponse was: ${codingRequiredResponse}`);
                                parsedCodingRequiredResponse = {};
                            }
                            const { codingRequired } = parsedCodingRequiredResponse;
                            if (codingRequired) {
                                const { codingMessage, codingTask } = parsedCodingRequiredResponse;
                                const message = typeof codingTask === 'string' 
                                    ? codingTask 
                                    : JSON.stringify(codingTask);
                                const { contextId } = args;
                                logger.info(`Sending task message coding agent: ${message}`);
                                codeRequestId = await sendMessageToQueue({ message, contextId });

                                toolCallbackId = codeRequestId;
                                toolCallbackName = "coding";
                                toolCallbackMessage = codingMessage;
                                break;
                            }
                        }
                        break;
                    case "image":
                        if (toolRequired) {
                            toolCallbackName = 'sys_generator_image';
                            toolCallbackMessage = toolMessage;
                            //const imageResponse = await callPathway('sys_generator_image', { ...args, useMemory: true }, pathwayResolver);
                            //pathwayResolver.tool = JSON.stringify({ search: false, title });
                            //return JSON.stringify({response: imageResponse});
                        }
                        break;
                    case "vision":
                    case "video":
                    case "audio":
                    case "pdf":
                        if (visionContentPresent) {
                            toolCallbackName = 'sys_generator_video_vision';
                            toolCallbackMessage = toolMessage;
                            //const videoResponse = await callPathway('sys_generator_video_vision', { ...args, chatHistory: multiModalChatHistory }, pathwayResolver);
                            //pathwayResolver.tool = JSON.stringify({ search: false, title });
                            //return JSON.stringify({response: videoResponse});
                        }
                        break;
                    case "code":
                    case "write":
                    case "reason":
                        if (toolRequired) {
                            toolCallbackName = 'sys_generator_expert';
                            toolCallbackMessage = toolMessage;
                            //const expertResponse = await callPathway('sys_generator_expert', { ...args, chatHistory: multiModalChatHistory }, pathwayResolver);
                            //pathwayResolver.tool = JSON.stringify({ search: false, title });
                            //return JSON.stringify({response: expertResponse, search: false });
                        }
                        break;
                    case "search":
                        if (searchRequired) {
                            toolCallbackName = 'sys_generator_results';
                            toolCallbackId = null;
                            toolCallbackMessage = toolMessage;
                        }
                        break;
                    default:
                        break;
                }
            }

            if (toolCallbackName) {
                pathwayResolver.tool = JSON.stringify({ 
                    hideFromModel: true, 
                    toolCallbackName, 
                    title,
                    search: toolCallbackName === 'sys_generator_results' ? true : false,
                    coding: toolCallbackName === 'coding' ? true : false,
                    codeRequestId,
                    toolCallbackId
                });
                return JSON.stringify({response: toolCallbackMessage || "One moment please."});
            }

            const chatResponse = await fetchChatResponsePromise;
            pathwayResolver.tool = JSON.stringify({ search: false, title })
            return JSON.stringify({response: chatResponse});

        } catch (e) {
            pathwayResolver.logError(e);
            const chatResponse = await fetchChatResponsePromise;
            pathwayResolver.tool = JSON.stringify({ search: false, title });
            return JSON.stringify({response: chatResponse});
        }
    }
};

