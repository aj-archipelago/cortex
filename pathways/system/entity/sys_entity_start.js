// sys_entity_start.js
// Beginning of the rag workflow for Jarvis
import { callPathway, say } from '../../../lib/pathwayTools.js';
import logger from  '../../../lib/logger.js';
import { chatArgsHasImageUrl, removeOldImageAndFileContent } from  '../../../lib/util.js';
import { QueueServiceClient } from '@azure/storage-queue';
import { config } from '../../../config.js';
import { insertToolCallAndResults } from './memory/shared/sys_memory_helpers.js';

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
        logger.error(`Error sending message: ${error instanceof Error ? error.stack || error.message : JSON.stringify(error)}`);
    }
}

export default {
    useInputChunking: false,
    enableDuplicateRequests: false,
    model: 'oai-gpt4o',
    useSingleTokenStream: false,
    inputParameters: {
        privateData: false,    
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        indexName: ``,
        semanticConfiguration: ``,
        roleInformation: ``,    
        calculateEmbeddings: false,
        dataSources: ["mydata", "aja", "aje", "wires"],
        language: "English",
        aiName: "Jarvis",
        aiMemorySelfModify: true,
        aiStyle: "OpenAI",
        title: ``,
        messages: [],
        voiceResponse: false,
        codeRequestId: ``,
        skipCallbackMessage: false
    },
    timeout: 600,
  
    executePathway: async ({args, resolver}) => {
        let title = null;
        let codeRequestId = null;

        const pathwayResolver = resolver;

        // add the entity constants to the args
        args = {
            ...args,
            ...config.get('entityConstants')
        };
                
        // set the style model if applicable
        const { aiStyle, AI_STYLE_ANTHROPIC, AI_STYLE_OPENAI } = args;
        const styleModel = aiStyle === "Anthropic" ? AI_STYLE_ANTHROPIC : AI_STYLE_OPENAI;

        // Limit the chat history to 20 messages to speed up processing
        if (args.messages && args.messages.length > 0) {
            args.chatHistory = args.messages.slice(-20);
        } else {
            args.chatHistory = args.chatHistory.slice(-20);
        }

        // if the model has been overridden, make sure to use it
        if (pathwayResolver.modelName) {
            args.model = pathwayResolver.modelName;
        }

        // remove old image and file content
        const visionContentPresent = chatArgsHasImageUrl(args);
        visionContentPresent && (args.chatHistory = removeOldImageAndFileContent(args.chatHistory));

        // truncate the chat history
        const truncatedChatHistory = pathwayResolver.modelExecutor.plugin.truncateMessagesToTargetLength(args.chatHistory, null, 1000);

        // Add the memory context to the chat history if applicable
        if (args.chatHistory.length > 1) {
            const memoryContext = await callPathway('sys_read_memory', { ...args, chatHistory: truncatedChatHistory, section: 'memoryContext', priority: 0, recentHours: 0, stream: false }, pathwayResolver);
            if (memoryContext) {
                insertToolCallAndResults(args.chatHistory, "search memory for relevant information", "memory_lookup", memoryContext);
            }
        }
      
        // If we're using voice, get a quick response to say
        let ackResponse = null;
        if (args.voiceResponse) {
            ackResponse = await callPathway('sys_generator_ack', { ...args, chatHistory: truncatedChatHistory, stream: false });
            if (ackResponse && ackResponse !== "none") {
                await say(pathwayResolver.requestId, ackResponse, 100);
                args.chatHistory.push({ role: 'assistant', content: ackResponse });
            }
        }

        // start fetching responses in parallel if not streaming
        let fetchChatResponsePromise;
        if (!args.stream) {
            fetchChatResponsePromise = callPathway('sys_generator_quick', {...args, model: styleModel, ackResponse}, pathwayResolver);
        }
        const fetchTitleResponsePromise = callPathway('chat_title', {...args, chatHistory: truncatedChatHistory, stream: false});

        try {
            // Get tool routing response
            const toolRequiredResponse = await callPathway('sys_router_tool', { 
                ...args,
                chatHistory: truncatedChatHistory.slice(-4),
                stream: false
            });

            // Asynchronously manage memory for this context
            if (args.aiMemorySelfModify) {
                callPathway('sys_memory_manager', {  ...args, chatHistory: truncatedChatHistory, stream: false })    
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

            title = await fetchTitleResponsePromise;

            pathwayResolver.tool = JSON.stringify({ 
                hideFromModel: (!args.stream && toolCallbackName) ? true : false, 
                toolCallbackName, 
                title,
                search: toolCallbackName === 'sys_generator_results' ? true : false,
                coding: toolCallbackName === 'coding' ? true : false,
                codeRequestId,
                toolCallbackId
            });

            if (toolCallbackMessage) {
                if (args.skipCallbackMessage) {
                    return await callPathway('sys_entity_continue', { ...args, stream: false, model: styleModel, generatorPathway: toolCallbackName }, pathwayResolver);
                }

                if (args.stream) {
                    if (!ackResponse) {
                        await say(pathwayResolver.requestId, toolCallbackMessage || "One moment please.", 10, args.voiceResponse ? true : false);
                    }
                    await callPathway('sys_entity_continue', { ...args, stream: true, generatorPathway: toolCallbackName }, pathwayResolver); 
                    return;
                }
                
                return toolCallbackMessage || "One moment please.";
            }

            const chatResponse = await (fetchChatResponsePromise || callPathway('sys_generator_quick', {...args, model: styleModel, ackResponse}, pathwayResolver));
            pathwayResolver.tool = JSON.stringify({ search: false, title });
            return args.stream ? null : chatResponse;

        } catch (e) {
            pathwayResolver.logError(e);
            const chatResponse = await (fetchChatResponsePromise || callPathway('sys_generator_quick', {...args, model: styleModel, ackResponse}, pathwayResolver));
            pathwayResolver.tool = JSON.stringify({ search: false, title });
            return args.stream ? null : chatResponse;
        }
    }
};

