// sys_entity_start.js
// Beginning of the rag workflow for Jarvis
import { callPathway, say } from '../../../lib/pathwayTools.js';
import logger from  '../../../lib/logger.js';
import { chatArgsHasImageUrl } from  '../../../lib/util.js';
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
    anthropicModel: 'claude-35-sonnet-vertex',
    openAIModel: 'oai-gpt4o',
    useSingleTokenStream: false,
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
        messages: [],
        voiceResponse: false,
        codeRequestId: ``,
    },
    timeout: 600,
    tokenRatio: TOKEN_RATIO,
    ...entityConstants,

    executePathway: async ({args, resolver}) => {
        let title = null;
        let codeRequestId = null;

        args = {
            ...args,
            ...entityConstants
        };

        // Limit the chat history to 20 messages to speed up processing
        if (args.messages && args.messages.length > 0) {
            args.chatHistory = args.messages.slice(-20);
        } else {
            args.chatHistory = args.chatHistory.slice(-20);
        }

        const pathwayResolver = resolver;
        const { anthropicModel, openAIModel } = pathwayResolver.pathway;
        const styleModel = args.aiStyle === "Anthropic" ? anthropicModel : openAIModel;

        // if the model has been overridden, make sure to use it
        if (pathwayResolver.modelName) {
            args.model = pathwayResolver.modelName;
        }

        const memoryContext = await callPathway('sys_read_memory', { ...args, section: 'memoryContext', priority: 0, recentHours: 0, stream: false }, pathwayResolver);
        if (memoryContext) {
            args.chatHistory.splice(-1, 0, { role: 'assistant', content: memoryContext });
        }
        
        let ackResponse = null;
        if (args.voiceResponse) {
            ackResponse = await callPathway('sys_generator_ack', { ...args, stream: false });
            if (ackResponse && ackResponse !== "none") {
                await say(pathwayResolver.requestId, ackResponse, 100);
                args.chatHistory.push({ role: 'assistant', content: ackResponse });
            }
        }

        const fetchChatResponse = async (args, pathwayResolver) => {
            const [chatResponse, chatTitleResponse] = await Promise.all([
                callPathway('sys_generator_quick', {...args, model: styleModel }, pathwayResolver),
                callPathway('chat_title', { ...args, stream: false}),
            ]);

            title = chatTitleResponse;

            return chatResponse;
        };
            
        const { chatHistory } = args;

        // start fetching the default response - we may need it later
        let fetchChatResponsePromise;
        if (!args.stream) {
            fetchChatResponsePromise = fetchChatResponse({ ...args, ackResponse }, pathwayResolver);
        }

        const visionContentPresent = chatArgsHasImageUrl(args);

        try {
            // Get tool routing response
            const toolRequiredResponse = await callPathway('sys_router_tool', { 
                ...args,
                chatHistory: chatHistory.slice(-4),
                stream: false
            });

            // Asynchronously manage memory for this context
            if (args.aiMemorySelfModify) {
                callPathway('sys_memory_manager', {  ...args, stream: false })    
                .catch(error => logger.error(error?.message || "Error in sys_memory_manager pathway"));
            }

            const { toolRequired, toolMessage, toolFunction } = JSON.parse(toolRequiredResponse || '{}');
            let toolCallbackName, toolCallbackId, toolCallbackMessage;

            logger.info(`toolRequired: ${toolRequired}, toolFunction: ${toolFunction}`);

            if (toolRequired && toolFunction) {
                switch (toolFunction.toLowerCase()) {
                    case "codeexecution":
                        {
                            const codingRequiredResponse = await callPathway('sys_router_code', { ...args, stream: false });
                            let parsedCodingRequiredResponse;
                            try {
                                parsedCodingRequiredResponse = JSON.parse(codingRequiredResponse || "{}");
                            } catch (error) {
                                logger.error(`Error parsing codingRequiredResponse: ${error.message}, codingRequiredResponse was: ${codingRequiredResponse}`);
                                parsedCodingRequiredResponse = {};
                            }
                            const { codingRequired } = parsedCodingRequiredResponse;
                            if (codingRequired) {
                                const { codingMessage, codingTask, codingTaskKeywords } = parsedCodingRequiredResponse;
                                const message = typeof codingTask === 'string' 
                                    ? codingTask 
                                    : JSON.stringify(codingTask);
                                const { contextId } = args;
                                logger.info(`Sending task message coding agent: ${message}`);
                                codeRequestId = await sendMessageToQueue({ message, contextId, keywords: codingTaskKeywords });

                                toolCallbackId = codeRequestId;
                                toolCallbackName = "coding";
                                toolCallbackMessage = codingMessage;
                                break;
                            }
                        }
                        break;
                    case "image":
                        toolCallbackName = 'sys_generator_image';
                        toolCallbackMessage = toolMessage;
                        break;
                    case "vision":
                    case "video":
                    case "audio":
                    case "pdf":
                    case "text":
                        if (visionContentPresent) {
                            toolCallbackName = 'sys_generator_video_vision';
                            toolCallbackMessage = toolMessage;
                        }
                        break;
                    case "code":
                    case "write":
                        toolCallbackName = 'sys_generator_expert';
                        toolCallbackMessage = toolMessage;
                        break;
                    case "reason":
                        toolCallbackName = 'sys_generator_reasoning';
                        toolCallbackMessage = toolMessage;
                        break;
                    case "search":
                        toolCallbackName = 'sys_generator_results';
                        toolCallbackId = null;
                        toolCallbackMessage = toolMessage;
                        break;
                    case "document":
                        toolCallbackName = 'sys_generator_document';
                        toolCallbackId = null;
                        toolCallbackMessage = toolMessage;
                        break;
                    case "clarify":
                        toolCallbackName = null;
                        toolCallbackId = null;
                        toolCallbackMessage = toolMessage;
                        break;
                    case "memory":
                        toolCallbackName = 'sys_generator_memory';
                        toolCallbackId = null;
                        toolCallbackMessage = toolMessage;
                        break;
                    default:
                        toolCallbackName = null;
                        toolCallbackId = null;
                        toolCallbackMessage = null;
                        break;
                }
            }

            if (toolCallbackMessage) {
                if (args.stream) {
                    if (!ackResponse) {
                        await say(pathwayResolver.requestId, toolCallbackMessage || "One moment please.", 10);
                    }
                    pathwayResolver.tool = JSON.stringify({ hideFromModel: false, search: false, title });  
                    await callPathway('sys_entity_continue', { ...args, stream: true, model: styleModel, generatorPathway: toolCallbackName }, pathwayResolver);
                    return "";
                } else {
                    pathwayResolver.tool = JSON.stringify({ 
                        hideFromModel: toolCallbackName ? true : false, 
                        toolCallbackName, 
                        title,
                        search: toolCallbackName === 'sys_generator_results' ? true : false,
                        coding: toolCallbackName === 'coding' ? true : false,
                        codeRequestId,
                        toolCallbackId
                    });
                    return toolCallbackMessage || "One moment please.";
                }
            }

            const chatResponse = await (fetchChatResponsePromise || fetchChatResponse({ ...args, ackResponse }, pathwayResolver));
            pathwayResolver.tool = JSON.stringify({ search: false, title });
            return args.stream ? "" : chatResponse;

        } catch (e) {
            pathwayResolver.logError(e);
            const chatResponse = await (fetchChatResponsePromise || fetchChatResponse({ ...args, ackResponse }, pathwayResolver));
            pathwayResolver.tool = JSON.stringify({ search: false, title });
            return args.stream ? "" : chatResponse;
        }
    }
};

