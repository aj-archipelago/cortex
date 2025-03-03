// gemini15ChatPlugin.js
import ModelPlugin from './modelPlugin.js';
import logger from '../../lib/logger.js';

const mergeResults = (data) => {
    let output = '';
    let safetyRatings = [];
    const RESPONSE_BLOCKED = 'The response was blocked because the input or response potentially violates policies. Try rephrasing the prompt or adjusting the parameter settings.';

    for (let chunk of data) {
        const { promptfeedback } = chunk;
        if (promptfeedback) {
            const { blockReason } = promptfeedback;
            if (blockReason) {
                logger.warn(`Response blocked due to prompt feedback: ${blockReason}`);
                return {mergedResult: RESPONSE_BLOCKED, safetyRatings: safetyRatings};
            }
        }

        const { candidates } = chunk;
        if (!candidates || !candidates.length) {
            continue;
        }

        // If it was blocked, return the blocked message
        if (candidates[0].safetyRatings?.some(rating => rating.blocked)) {
            safetyRatings = candidates[0].safetyRatings;
            logger.warn(`Response blocked due to safety ratings: ${JSON.stringify(safetyRatings, null, 2)}`);
            return {mergedResult: RESPONSE_BLOCKED, safetyRatings: safetyRatings};
        }

        // Append the content of the first part of the first candidate to the output
        const message = candidates[0].content.parts[0].text;
        output += message;
    }

    return {mergedResult: output || null, safetyRatings: safetyRatings};
};

class Gemini15ChatPlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
    }

    // This code converts either OpenAI or PaLM messages to the Gemini messages format
    convertMessagesToGemini(messages) {
        let modifiedMessages = [];
        let systemParts = [];
        let lastAuthor = '';

        // Check if the messages are already in the Gemini format
        if (messages[0] && Object.prototype.hasOwnProperty.call(messages[0], 'parts')) {
            modifiedMessages = messages;
        } else {
            messages.forEach(message => {
                const { role, author, content } = message;
        
                if (role === 'system') {
                    if (Array.isArray(content)) {
                        content.forEach(item => systemParts.push({ text: item }));
                    } else {
                        systemParts.push({ text: content });
                    }
                    return;
                }
        
                // Aggregate consecutive author messages, appending the content
                if ((role === lastAuthor || author === lastAuthor) && modifiedMessages.length > 0) {
                    modifiedMessages[modifiedMessages.length - 1].parts.push({ text: content });
                }

                // Push messages that are role: 'user' or 'assistant', changing 'assistant' to 'model'
                else if (role === 'user' || role === 'assistant' || author) {
                    modifiedMessages.push({
                        role: author || role,
                        parts: [{ text: content }],
                    });
                    lastAuthor = author || role;
                }
            });
        }
    
        // Gemini requires an odd number of messages
        if (modifiedMessages.length % 2 === 0) {
            modifiedMessages = modifiedMessages.slice(1);
        }

        const system = { role: 'user', parts: systemParts };

        return {
            modifiedMessages,
            system,
        };
    }

    // Set up parameters specific to the Gemini API
    getRequestParameters(text, parameters, prompt, cortexRequest) {
        const { modelPromptText, modelPromptMessages, tokenLength } = this.getCompiledPrompt(text, parameters, prompt);
        const { geminiSafetySettings, geminiTools, max_tokens } = cortexRequest ? cortexRequest.pathway : {};

        // Define the model's max token length
        const modelTargetTokenLength = this.getModelMaxTokenLength() * this.getPromptTokenRatio();
    
        const geminiMessages = this.convertMessagesToGemini(modelPromptMessages || [{ "role": "user", "parts": [{ "text": modelPromptText }]}]);
        
        let requestMessages = geminiMessages.modifiedMessages;
        let system = geminiMessages.system;

        // Check if the token length exceeds the model's max token length
        if (tokenLength > modelTargetTokenLength) {
            // Remove older messages until the token length is within the model's limit
            requestMessages = this.truncateMessagesToTargetLength(requestMessages, modelTargetTokenLength);
        }
        
        if (max_tokens < 0) {
            throw new Error(`Prompt is too long to successfully call the model at ${tokenLength} tokens.  The model will not be called.`);
        }
    
        const requestParameters = {
        contents: requestMessages,
        generationConfig: {
            temperature: this.temperature || 0.7,
            maxOutputTokens: max_tokens || this.getModelMaxReturnTokens(),
            topP: parameters.topP || 0.95,
            topK: parameters.topK || 40,
        },
        safety_settings: geminiSafetySettings || undefined,
        systemInstruction: system,
        tools: geminiTools || undefined
        };
    
        return requestParameters;
    }

    // Parse the response from the new Chat API
    parseResponse(data) {
        // If data is not an array, return it directly
        let dataToMerge = [];
        if (data && data.contents && Array.isArray(data.contents)) {
            dataToMerge = data.contents;
        } else if (data && data.candidates && Array.isArray(data.candidates)) {
            const { content, finishReason, safetyRatings } = data.candidates[0];
            if (finishReason === 'STOP' || finishReason === 'MAX_TOKENS') {
                return content?.parts?.[0]?.text ?? '';
            } else {
                const returnString = `Response was not completed.  Finish reason: ${finishReason}, Safety ratings: ${JSON.stringify(safetyRatings, null, 2)}`;
                throw new Error(returnString);
            }
        } else if (Array.isArray(data)) {
            dataToMerge = data;
        } else {
            return data;
        }

        return mergeResults(dataToMerge).mergedResult || null;
    
    }

    // Execute the request to the new Chat API
    async execute(text, parameters, prompt, cortexRequest) {
        const requestParameters = this.getRequestParameters(text, parameters, prompt, cortexRequest);
        const { stream } = parameters;

        cortexRequest.data = { ...(cortexRequest.data || {}), ...requestParameters };
        cortexRequest.params = {}; // query params
        cortexRequest.stream = stream;
        cortexRequest.urlSuffix = cortexRequest.stream ? ':streamGenerateContent?alt=sse' : ':generateContent';

        const gcpAuthTokenHelper = this.config.get('gcpAuthTokenHelper');
        const authToken = await gcpAuthTokenHelper.getAccessToken();
        cortexRequest.auth.Authorization = `Bearer ${authToken}`;

        return this.executeRequest(cortexRequest);
    }

    processStreamEvent(event, requestProgress) {
        const eventData = JSON.parse(event.data);
        
        // Initialize requestProgress if needed
        requestProgress = requestProgress || {};
        requestProgress.data = requestProgress.data || null;
        
        // Create a helper function to generate message chunks
        const createChunk = (delta) => ({
            id: eventData.responseId || `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: this.modelName,
            choices: [{
                index: 0,
                delta,
                finish_reason: null
            }]
        });

        // Handle content chunks - do this first before handling any finish conditions
        if (eventData.candidates?.[0]?.content?.parts?.[0]?.text) {
            if (!requestProgress.started) {
                // First chunk - send role
                requestProgress.data = JSON.stringify(createChunk({ role: "assistant" }));
                requestProgress.started = true;
                
                // Immediately follow up with the first content chunk
                requestProgress.data = JSON.stringify(createChunk({ 
                    content: eventData.candidates[0].content.parts[0].text 
                }));
            } else {
                // Send content chunk
                requestProgress.data = JSON.stringify(createChunk({ 
                    content: eventData.candidates[0].content.parts[0].text 
                }));
            }

            // If this message also has STOP, mark it for completion but don't overwrite the content
            if (eventData.candidates[0].finishReason === "STOP") {
                // Send the content first
                requestProgress.data = JSON.stringify(createChunk({ 
                    content: eventData.candidates[0].content.parts[0].text
                }));
                requestProgress.progress = 1;
            }
        } else if (eventData.candidates?.[0]?.finishReason === "STOP") {
            // Only send DONE if there was no content in this message
            requestProgress.data = '[DONE]';
            requestProgress.progress = 1;
        }

        // Handle safety blocks
        if (eventData.candidates?.[0]?.safetyRatings?.some(rating => rating.blocked)) {
            requestProgress.data = JSON.stringify({
                id: eventData.responseId || `chatcmpl-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: this.modelName,
                choices: [{
                    index: 0,
                    delta: { content: "\n\n*** Response blocked due to safety ratings ***" },
                    finish_reason: "content_filter"
                }]
            });
            requestProgress.progress = 1;
            return requestProgress;
        }

        // Handle prompt feedback blocks
        if (eventData.promptFeedback?.blockReason) {
            requestProgress.data = JSON.stringify({
                id: eventData.responseId || `chatcmpl-${Date.now()}`,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                model: this.modelName,
                choices: [{
                    index: 0,
                    delta: { content: `\n\n*** Response blocked: ${eventData.promptFeedback.blockReason} ***` },
                    finish_reason: "content_filter"
                }]
            });
            requestProgress.progress = 1;
            return requestProgress;
        }

        return requestProgress;
    }

    // Override the logging function to display the messages and responses
    logRequestData(data, responseData, prompt) {
        const messages = data && data.contents;
        
        if (messages && messages.length > 1) {
            logger.info(`[chat request contains ${messages.length} messages]`);
            messages.forEach((message, index) => {
                const messageContent = message.parts.reduce((acc, part) => {
                    if (part.text) {
                        return acc + part.text;
                    } else if (part.inlineData) {
                        return acc + '* base64 data truncated for log *';
                    } else if (part.fileData) {
                        return acc + part.fileData.fileUri;
                    }
                    return acc;
                } , '');
                const { length, units } = this.getLength(messageContent);
                const preview = this.shortenContent(messageContent);
    
                logger.verbose(`message ${index + 1}: role: ${message.role}, ${units}: ${length}, content: "${preview}"`);
            });
        } else if (messages && messages.length === 1) {
            const messageContent = messages[0].parts.reduce((acc, part) => {
                if (part.text) {
                    return acc + part.text;
                } else if (part.inlineData) {
                    return acc + '* base64 data truncated for log *';
                } else if (part.fileData) {
                    return acc + part.fileData.fileUri;
                }
                return acc;
            } , '');
            logger.verbose(`${this.shortenContent(messageContent)}`);
        }

        // check if responseData is an array or string
        if (typeof responseData === 'string') {
            const { length, units } = this.getLength(responseData);
            logger.info(`[response received containing ${length} ${units}]`);
            logger.verbose(`${this.shortenContent(responseData)}`);
        } else if (Array.isArray(responseData)) {
            const { mergedResult, safetyRatings } = mergeResults(responseData);
            if (safetyRatings?.length) {
                logger.warn(`response was blocked because the input or response potentially violates policies`);
                logger.verbose(`Safety Ratings: ${JSON.stringify(safetyRatings, null, 2)}`);
            }
            const { length, units } = this.getLength(mergedResult);
            logger.info(`[response received containing ${length} ${units}]`);
            logger.verbose(`${this.shortenContent(mergedResult)}`);
        } else {
            logger.info(`[response received as an SSE stream]`);
        }

        if (prompt && prompt.debugInfo) {
            prompt.debugInfo += `\n${JSON.stringify(data)}`;
        }
    }

}

export default Gemini15ChatPlugin;