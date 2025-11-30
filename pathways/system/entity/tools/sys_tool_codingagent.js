// sys_tool_codingagent.js
// Entity tool that provides code execution capabilities through a queue-based system

import { QueueServiceClient } from '@azure/storage-queue';
import logger from '../../../../lib/logger.js';
import { resolveFileParameter } from '../../../../lib/fileUtils.js';

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
        handoff: true, // This tool hands off to an async agent, so skip task completion check
        function: {
            name: "CodeExecution",
            description: "This tool allows you to asynchronously engage an agent to write and execute code in a sandbox to perform a task on your behalf. Use when explicitly asked to run or execute code, or when a coding agent is needed to perform specific tasks - examples include data analysis, file manipulation, or other tasks that require code execution. With this tool you can read and write files and also access internal databases and query them directly. This will start a background task and return results directly to the user.  You will not receive the response.",
            parameters: {
                type: "object",
                properties: {
                    codingTask: {
                        type: "string",
                        description: "Detailed task description for the coding agent. Include all necessary information as this is the only message the coding agent receives. Let the agent decide how to solve it without making assumptions about its capabilities. IMPORTANT: The coding agent does not share your context, so you must provide it with all the information in this message."
                    },
                    inputFiles: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "A list of input files (from Available Files section or ListFileCollection or SearchFileCollection) that the coding agent must use to complete the task. Each file should be the hash or filename. Omit this parameter if no input files are needed."
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message to notify the user that a coding task is being handled"
                    },
                    codingTaskKeywords: {
                        type: "string",
                        description: "Keywords for the coding agent's internal Azure Cognitive Search index to help the coding agent find relevant code snippets"
                    }
                },
                required: ["codingTask", "userMessage", "codingTaskKeywords"]
            }
        }
    }],
    
    executePathway: async ({args, resolver}) => {
        try {
            const { codingTask, userMessage, inputFiles, codingTaskKeywords, contextId, contextKey } = args;

            let taskSuffix = "";
            if (inputFiles) {
                if (!contextId) {
                    throw new Error("contextId is required when using the 'inputFiles' parameter. Use ListFileCollection or SearchFileCollection to find available files.");
                }
                
                // Resolve file parameters to URLs
                // inputFiles is an array of strings (file hashes or filenames)
                const fileReferences = Array.isArray(inputFiles) 
                    ? inputFiles.map(ref => String(ref).trim()).filter(ref => ref.length > 0)
                    : [];
                
                const resolvedUrls = [];
                const failedFiles = [];
                
                for (const fileRef of fileReferences) {
                    // Try to resolve each file reference
                    const resolvedUrl = await resolveFileParameter(fileRef, contextId, contextKey);
                    if (resolvedUrl) {
                        resolvedUrls.push(resolvedUrl);
                    } else {
                        failedFiles.push(fileRef);
                    }
                }
                
                // Fail early if any files couldn't be resolved
                if (failedFiles.length > 0) {
                    const fileList = failedFiles.length === 1 
                        ? `"${failedFiles[0]}"` 
                        : failedFiles.map(f => `"${f}"`).join(', ');
                    throw new Error(`File(s) not found: ${fileList}. Use ListFileCollection or SearchFileCollection to find available files.`);
                }
                
                if (resolvedUrls.length > 0) {
                    taskSuffix = `You must use the following files as input to complete the task: ${resolvedUrls.join(', ')}.`
                }
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

            // Return explicit message that task has started but is not complete yet
            const statusMessage = "⚠️ **Task Status**: The coding task has been started and is now running in the background. Don't make up any information about the task or task results - just say that it has been started and is running. The user will be able to see the progress and results of the task, but you will not receive the response. No further action is required from you or the user.";         
            return statusMessage;
        } catch (error) {
            logger.error(`Error in coding agent tool: ${error instanceof Error ? error.stack || error.message : JSON.stringify(error)}`);
            throw error;
        }
    }
}; 