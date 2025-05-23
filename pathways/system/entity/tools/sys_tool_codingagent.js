// sys_tool_codingagent.js
// Entity tool that provides code execution capabilities through a queue-based system

import { QueueServiceClient } from '@azure/storage-queue';
import logger from '../../../../lib/logger.js';

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
        throw error;
    }
}

export default {
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        aiName: "Jarvis",
        language: "English",
    },
    max_tokens: 100000,
    model: 'oai-gpt41',
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 600,
    toolDefinition: [{
        type: "function",
        icon: "🤖",
        function: {
            name: "CodeExecution",
            description: "This tool allows you to engage an agent to write and execute code to perform a task on your behalf. Use when explicitly asked to run or execute code, or when a coding agent is needed to perform specific tasks - examples include data analysis, file manipulation, or other tasks that require code execution. With this tool you can also access internal databases and query them directly. This will start a background task and return - you will not receive the response immediately.",
            parameters: {
                type: "object",
                properties: {
                    codingTask: {
                        type: "string",
                        description: "Detailed task description for the coding agent. Include all necessary information as this is the only message the coding agent receives. Let the agent decide how to solve it without making assumptions about its capabilities. IMPORTANT: The coding agent does not share your context, so you must provide it with all the information in this message."
                    },
                    inputFiles: {
                        type: "string",
                        description: "A list of input files that the coding agent must use to complete the task. Each file should be the fully-qualified URL to the file. Omit this parameter if no input files are needed."
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message to notify the user that a coding task is being handled"
                    },
                    codingTaskKeywords: {
                        type: "string",
                        description: "Keywords for Azure Cognitive Search to help the coding agent find relevant code snippets"
                    }
                },
                required: ["codingTask", "userMessage", "codingTaskKeywords"]
            }
        }
    }],
    
    executePathway: async ({args, resolver}) => {
        try {
            const { codingTask, userMessage, inputFiles, codingTaskKeywords } = args;
            const { contextId } = args;

            let taskSuffix = "";
            if (inputFiles) {
                taskSuffix = `You must use the following files as input to complete the task: ${inputFiles}.`
            }


            // Send the task to the queue
            const codeRequestId = await sendMessageToQueue({ 
                message: `${codingTask}\n\n${taskSuffix}`, 
                contextId, 
                keywords: codingTaskKeywords 
            });

            // Set the tool response
            resolver.tool = JSON.stringify({ 
                toolUsed: "coding",
                codeRequestId,
                toolCallbackName: "coding",
                toolCallbackId: codeRequestId,
                toolCallbackMessage: userMessage
            });

            return userMessage || "I've started working on your coding task. I'll let you know when it's complete.";
        } catch (error) {
            logger.error("Error in coding agent tool:", error);
            throw error;
        }
    }
}; 