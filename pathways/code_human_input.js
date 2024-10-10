import { QueueServiceClient } from '@azure/storage-queue';

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
let queueClient;

if (connectionString) {
  const queueName = process.env.HUMAN_INPUT_QUEUE_NAME || "autogen-human-input-queue";
  const queueClientService = QueueServiceClient.fromConnectionString(connectionString);
  queueClient = queueClientService.getQueueClient(queueName);
} else {
  console.warn("Azure Storage connection string is not provided. Queue operations will be unavailable.");
}

async function sendMessageToQueue(data) {
    try {
        if(!queueClient){
            console.warn("Azure Storage connection string is not provided. Queue operations will be unavailable.");
            return;
        }
        const encodedMessage = Buffer.from(JSON.stringify(data)).toString('base64');
        const result = await queueClient.sendMessage(encodedMessage);
        console.log(`Message added to queue: ${JSON.stringify(result)}`);
        return result.messageId;
    } catch (error) {
        console.error("Error sending message:", error);
    }
}

export default {
    useInputChunking: false,
    enableDuplicateRequests: false,
    inputParameters: {
        codeRequestId: "",
        text: "",
    },
    timeout: 300,
    executePathway: async ({ args }) => {
        const { codeRequestId, text } = args;
        const data = {
            codeRequestId,
            text,
        };
        const response = await sendMessageToQueue(data);
        return JSON.stringify({response});
    },
};

