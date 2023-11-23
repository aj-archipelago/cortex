// OpenAIAssistantPlugin.js
import axios from 'axios';
import { config } from '../../config.js';
import ModelPlugin from './modelPlugin.js';

class OpenAIAssistantsPlugin extends ModelPlugin {
    constructor(config, pathway, modelName, model) {
        super(config, pathway, modelName, model);
    }

    async createThread(threadData) {
        const url = `${this.requestUrl()}/threads`;
        try {
            const response = await axios.post(url, threadData, { cache: false, headers: { ...this.model.headers } });
            return response.data;
        } catch (error) {
            console.error(`Error creating thread: ${error?.response?.data?.error?.message}`);
            throw error;
        }
    }

    async listMessages(threadId) {
        const url = `${this.requestUrl()}/threads/${threadId}/messages`;
        try {
            const response = await axios.get(url, { cache: false, headers: { ...this.model.headers } });
            return response.data;
        } catch (error) {
            console.error(`Error listing messages: ${error}`);
            throw error;
        }
    }

    async createRun(threadId, runData) {
        const url = `${this.requestUrl()}/threads/${threadId}/runs`;
        try {
            const response = await axios.post(url, runData, { cache: false, headers: { ...this.model.headers } });
            return response.data;
        } catch (error) {
            console.error(`Error creating run: ${error?.response?.data?.error?.message}`);
            throw error;
        }
    }

    async retrieveRun(threadId, runId) {
        const url = `${this.requestUrl()}/threads/${threadId}/runs/${runId}`;
        try {
            const response = await axios.get(url, { cache: false, headers: { ...this.model.headers } });
            return response.data;
        } catch (error) {
            console.error(`Error retrieving run: ${error}`);
            throw error;
        }
    }

    // convert to OpenAI messages array format if necessary
    convertPalmToOpenAIMessages(context, examples, messages) {
        let openAIMessages = [];

        // Add context as a system message
        if (context) {
            openAIMessages.push({
                role: 'system',
                content: context,
            });
        }

        // Add examples to the messages array
        examples.forEach(example => {
            openAIMessages.push({
                role: example.input.author || 'user',
                content: example.input.content,
            });
            openAIMessages.push({
                role: example.output.author || 'assistant',
                content: example.output.content,
            });
        });

        // Add remaining messages to the messages array
        messages.forEach(message => {
            openAIMessages.push({
                role: message.author,
                content: message.content,
            });
        });

        return openAIMessages;
    }

    // Set up parameters specific to the OpenAI Chat API
    getRequestParameters(text, parameters, prompt) {
        const { modelPromptText, modelPromptMessages, tokenLength, modelPrompt } = this.getCompiledPrompt(text, parameters, prompt);
        const { stream } = parameters;

        // Define the model's max token length
        const modelTargetTokenLength = this.getModelMaxTokenLength() * this.getPromptTokenRatio();

        let requestMessages = modelPromptMessages || [{ "role": "user", "content": modelPromptText }];

        // Check if the messages are in Palm format and convert them to OpenAI format if necessary
        const isPalmFormat = requestMessages.some(message => 'author' in message);
        if (isPalmFormat) {
            const context = modelPrompt.context || '';
            const examples = modelPrompt.examples || [];
            requestMessages = this.convertPalmToOpenAIMessages(context, examples, modelPromptMessages);
        }

        // Check if the token length exceeds the model's max token length
        if (tokenLength > modelTargetTokenLength) {
            // Remove older messages until the token length is within the model's limit
            requestMessages = this.truncateMessagesToTargetLength(requestMessages, modelTargetTokenLength);
        }

        const requestParameters = modelPromptMessages?.[modelPromptMessages?.length - 1];

        return requestParameters;
    }

    // Execute the request to the OpenAI Chat API
    async execute(text, parameters, prompt, pathwayResolver) {
        let threadId = parameters.threadId;

        if (!threadId) {
            const threadData = {
                messages: [],
            };

            const thread = await this.createThread(threadData);
            threadId = thread.id;
        }

        const url = `${this.requestUrl()}/threads/${threadId}/messages`;
        const requestParameters = this.getRequestParameters(text, parameters, prompt);
        const { requestId, pathway } = pathwayResolver;

        const data = { ...requestParameters };
        const params = {}; // query params
        const headers = this.model.headers || {};
        const response = await this.executeRequest(url, data, params, headers, prompt, requestId, pathway);

        response.threadId = threadId;

        const run = await this.createRun(
            threadId,
            { assistant_id: this.model.params.assistant_id });

        let runState = run.status;

        const timeout = 1000 * 60 * 5;
        const startTime = Date.now();
        const endTime = startTime + timeout;

        while (runState !== 'completed' && Date.now() < endTime) {
            const retrievedRun = await this.retrieveRun(threadId, run.id);
            runState = retrievedRun.status;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        const messages = await this.listMessages(threadId);
        pathwayResolver.currentThreadId = threadId;
        console.log(`\x1b[34m> ${messages?.data[0]?.content?.[0]?.text?.value}\x1b[0m`);
        return messages?.data[0]?.content?.[0]?.text?.value;
    }

    // Override the logging function to display the messages and responses
    logRequestData(data, responseData, prompt) {
        this.logAIRequestFinished();

        const { messages } = data;
        if (messages && messages.length > 1) {
            messages.forEach((message, index) => {
                const words = message.content.split(" ");
                const tokenCount = encode(message.content).length;
                const preview = words.length < 41 ? message.content : words.slice(0, 20).join(" ") + " ... " + words.slice(-20).join(" ");

                console.log(`\x1b[36mMessage ${index + 1}: Role: ${message.role}, Tokens: ${tokenCount}, Content: "${preview}"\x1b[0m`);
            });
        } else {
            console.log(`\x1b[36m${data.content}\x1b[0m`);
        }

        prompt && prompt.debugInfo && (prompt.debugInfo += `\n${JSON.stringify(data)}`);
    }
}

export default OpenAIAssistantsPlugin;
