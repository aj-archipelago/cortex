// rest.js
// Implement the REST endpoints for the pathways

import pubsub from './pubsub.js';
import { requestState } from './requestState.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../lib/logger.js';
import { getSingleTokenChunks } from './chunker.js';
import axios from 'axios';

const getOllamaModels = async (ollamaUrl) => {
    try {
        const response = await axios.get(`${ollamaUrl}/api/tags`);
        return response.data.models.map(model => ({
            id: `ollama-${model.name}`,
            object: 'model',
            owned_by: 'ollama',
            permission: ''
        }));
    } catch (error) {
        logger.error(`Error fetching Ollama models: ${error.message}`);
        return [];
    }
};

const chunkTextIntoTokens = (() => {
    let partialToken = '';
    return (text, isLast = false, useSingleTokenStream = false) => {
        const tokens = useSingleTokenStream ? getSingleTokenChunks(partialToken + text) : [text];
        if (isLast) {
            partialToken = '';
            return tokens;
        }
        partialToken = useSingleTokenStream ? tokens.pop() : '';
        return tokens;
    };
})();

// Helper functions to reduce code duplication
const resolveModelName = (modelName, openAIChatModels, openAICompletionModels, isChat = false) => {
    if (modelName.startsWith('ollama-')) {
        const pathwayName = isChat ? 'sys_ollama_chat' : 'sys_ollama_completion';
        return { pathwayName, isOllama: true };
    } else {
        const modelMap = isChat ? openAIChatModels : openAICompletionModels;
        const pathwayName = modelMap[modelName] || modelMap['*'];
        return { pathwayName, isOllama: false };
    }
};

const handleModelNotFound = (res, modelName) => {
    res.status(404).json({
        error: `Model ${modelName} not found.`,
    });
};

const extractResponseData = (pathwayResponse) => {
    if (typeof pathwayResponse === 'string') {
        return { resultText: pathwayResponse, resultData: null };
    }
    return {
        resultText: pathwayResponse.result || "",
        resultData: pathwayResponse.resultData || null
    };
};

const parseToolCalls = (resultData, resultText) => {
    let messageContent = resultText;
    let toolCalls = null;
    let functionCall = null;
    let finishReason = 'stop';

    // First check if we have structured response data from the pathway response
    if (resultData) {
        try {
            const parsedResultData = typeof resultData === 'string' ? JSON.parse(resultData) : resultData;
            
            // resultData contains the full CortexResponse object
            if (parsedResultData && parsedResultData.toolCalls) {
                toolCalls = parsedResultData.toolCalls;
                finishReason = 'tool_calls';
            } else if (parsedResultData && parsedResultData.functionCall) {
                functionCall = parsedResultData.functionCall;
                finishReason = 'function_call';
            }
        } catch (e) {
            // If parsing structured response fails, continue with regular parsing
        }
    }

    // If no tool data found, try parsing the result text as before for backward compatibility
    if (!toolCalls && !functionCall) {
        try {
            const parsedResponse = JSON.parse(resultText);
            
            // Check if this is a tool calls response
            if (parsedResponse.role === 'assistant' && parsedResponse.hasOwnProperty('tool_calls')) {
                if (parsedResponse.tool_calls) {
                    toolCalls = parsedResponse.tool_calls;
                    messageContent = parsedResponse.content || "";
                    finishReason = 'tool_calls';
                }
            } else if (parsedResponse.tool_calls) {
                toolCalls = parsedResponse.tool_calls;
                messageContent = parsedResponse.content || "";
                finishReason = 'tool_calls';
            }
            // Check if this is a legacy function call response
            else if (parsedResponse.role === 'assistant' && parsedResponse.hasOwnProperty('function_call')) {
                if (parsedResponse.function_call) {
                    functionCall = parsedResponse.function_call;
                    messageContent = parsedResponse.content || "";
                    finishReason = 'function_call';
                }
            } else if (parsedResponse.function_call) {
                functionCall = parsedResponse.function_call;
                messageContent = parsedResponse.content || "";
                finishReason = 'function_call';
            }
        } catch (e) {
            // If parsing fails, treat as regular text response
            messageContent = resultText;
        }
    }

    return { messageContent, toolCalls, functionCall, finishReason };
};

const generateResponseId = (prefix) => {
    const requestId = uuidv4();
    return `${prefix}-${requestId}`;
};

const processRestRequest = async (server, req, pathway, name, parameterMap = {}) => {
    const fieldVariableDefs = pathway.typeDef(pathway).restDefinition || [];

    const convertType = (value, type) => {
        if (type === 'Boolean') {
            return Boolean(value);
        } else if (type === 'Int') {
            return parseInt(value, 10);
        } else if (type === '[MultiMessage]' && Array.isArray(value)) {
            return value.map(msg => ({
                ...msg,
                content: Array.isArray(msg.content) ? 
                    msg.content.map(item => JSON.stringify(item)) : 
                    msg.content
            }));
        } else if (type === '[String]' && Array.isArray(value)) {
            return value;
        } else {
            return value;
        }
    };

    const variables = fieldVariableDefs.reduce((acc, variableDef) => {
        const requestBodyParamName = Object.keys(parameterMap).includes(variableDef.name)
            ? parameterMap[variableDef.name]
            : variableDef.name;

        if (Object.prototype.hasOwnProperty.call(req.body, requestBodyParamName)) {
            acc[variableDef.name] = convertType(req.body[requestBodyParamName], variableDef.type);
        }
        return acc;
    }, {});

    // Add tools to variables if they exist in the request
    if (req.body.tools) {
        variables.tools = JSON.stringify(req.body.tools);
    }
    
    if (req.body.tool_choice) {
        variables.tool_choice = req.body.tool_choice;
    }
    
    // Add functions to variables if they exist in the request (legacy function calling)
    if (req.body.functions) {
        variables.functions = JSON.stringify(req.body.functions);
    }

    const variableParams = fieldVariableDefs.map(({ name, type }) => `$${name}: ${type}`).join(', ');
    const queryArgs = fieldVariableDefs.map(({ name }) => `${name}: $${name}`).join(', ');

    const query = `
            query ${name}(${variableParams}) {
                    ${name}(${queryArgs}) {
                        contextId
                        previousResult
                        result
                        resultData
                        tool
                        warnings
                        errors
                        debug
                    }
                }
            `;

    // Debug: Log the variables being passed
    console.log('DEBUG: REST endpoint variables:', JSON.stringify(variables, null, 2));
    console.log('DEBUG: REST endpoint query:', query);
    
    const result = await server.executeOperation({ query, variables });

    // if we're streaming and there are errors, we return a standard error code
    if (Boolean(req.body.stream)) {
        if (result?.body?.singleResult?.errors) {
            return `[ERROR] ${result.body.singleResult.errors[0].message.split(';')[0]}`;
        }
    }
    
    // For non-streaming, return both result and tool fields
    const pathwayData = result?.body?.singleResult?.data?.[name];
    if (pathwayData) {
        return {
            result: pathwayData.result || "",
            resultData: pathwayData.resultData || null,
            tool: pathwayData.tool || null,
            errors: pathwayData.errors || null,
            warnings: pathwayData.warnings || null
        };
    }
    
    // If no pathway data, return error message
    const errorMessage = result?.body?.singleResult?.errors?.[0]?.message || "";
    return {
        result: errorMessage,
        resultData: null,
        tool: null,
        errors: errorMessage ? [errorMessage] : null,
        warnings: null
    };
};

const processIncomingStream = (requestId, res, jsonResponse, pathway) => {
    const useSingleTokenStream = pathway.useSingleTokenStream || false;

    const startStream = (res) => {
        // Set the headers for streaming
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
    }
    
    const finishStream = (res, jsonResponse) => {
        // Send the last partial token if it exists
        const lastTokens = chunkTextIntoTokens('', true, useSingleTokenStream);
        if (lastTokens.length > 0) {
            lastTokens.forEach(token => {
                fillJsonResponse(jsonResponse, token, null);
                sendStreamData(jsonResponse);
            });
        }

        // If we haven't sent the stop message yet, do it now
        if (jsonResponse.choices?.[0]?.finish_reason !== "stop") {
            let jsonEndStream = JSON.parse(JSON.stringify(jsonResponse));
    
            if (jsonEndStream.object === 'text_completion') {
                jsonEndStream.choices[0].index = 0;
                jsonEndStream.choices[0].finish_reason = "stop";
                jsonEndStream.choices[0].text = "";
            } else {
                jsonEndStream.choices[0].finish_reason = "stop";
                jsonEndStream.choices[0].index = 0;
                jsonEndStream.choices[0].delta = {};
            }
    
            sendStreamData(jsonEndStream);
        }
    
        sendStreamData('[DONE]');
        res.end();
    }

    const sendStreamData = (data) => {
        const dataString = (data==='[DONE]') ? data : JSON.stringify(data);

        if (!res.writableEnded) {
            res.write(`data: ${dataString}\n\n`);
            logger.debug(`REST SEND: data: ${dataString}`);
        }
    }

    const fillJsonResponse = (jsonResponse, inputText, _finishReason) => {
        jsonResponse.choices[0].finish_reason = null;
        if (jsonResponse.object === 'text_completion') {
            jsonResponse.choices[0].text = inputText;
        } else {
            // Ensure delta object exists
            if (!jsonResponse.choices[0].delta) {
                jsonResponse.choices[0].delta = {};
            }
            jsonResponse.choices[0].delta.content = inputText;
        }

        return jsonResponse;
    }

    const fillJsonResponseWithToolCalls = (jsonResponse, toolCalls, finishReason) => {
        jsonResponse.choices[0].finish_reason = finishReason;
        if (jsonResponse.object === 'text_completion') {
            // Handle text completion tool calls if needed
        } else {
            // Ensure delta object exists
            if (!jsonResponse.choices[0].delta) {
                jsonResponse.choices[0].delta = {};
            }
            jsonResponse.choices[0].delta.tool_calls = toolCalls;
        }
        return jsonResponse;
    }

    startStream(res);

    // If the requestId is an error message, we can't continue
    if (requestId.startsWith('[ERROR]')) {
        fillJsonResponse(jsonResponse, requestId, "stop");
        sendStreamData(jsonResponse);
        finishStream(res, jsonResponse);
        return;
    }

    let subscription;

    subscription = pubsub.subscribe('REQUEST_PROGRESS', (data) => {
        
        const safeUnsubscribe = async () => {
            if (subscription) {
                try {
                    const subPromiseResult = await subscription;
                    if (subPromiseResult && pubsub.subscriptions?.[subPromiseResult]) {
                        pubsub.unsubscribe(subPromiseResult);
                    }
                } catch (error) {
                    logger.warn(`Pubsub unsubscribe threw error: ${error}`);
                }
            }
        }

        const processStringData = (stringData) => {
            if (progress === 1 && stringData.trim() === "[DONE]") {
                fillJsonResponse(jsonResponse, stringData, "stop");
                safeUnsubscribe();
                finishStream(res, jsonResponse);
                return;
            }

            // Check if this is a tool call response
            try {
                const parsedData = JSON.parse(stringData);
                if (parsedData.tool_calls) {
                    // Send tool calls as a single chunk
                    fillJsonResponseWithToolCalls(jsonResponse, parsedData.tool_calls, "tool_calls");
                    sendStreamData(jsonResponse);
                    safeUnsubscribe();
                    finishStream(res, jsonResponse);
                    return;
                }
            } catch (e) {
                // Not JSON, treat as regular text
            }

            chunkTextIntoTokens(stringData, false, useSingleTokenStream).forEach(token => {
                fillJsonResponse(jsonResponse, token, null);
                sendStreamData(jsonResponse);
            });

            if (progress === 1) {
                safeUnsubscribe();
                finishStream(res, jsonResponse);
            }

        }

        if (data.requestProgress.requestId !== requestId) return;

        logger.debug(`REQUEST_PROGRESS received progress: ${data.requestProgress.progress}, data: ${data.requestProgress.data}`);
        
        const { progress, data: progressData } = data.requestProgress;

        try {
            const messageJson = JSON.parse(progressData);

            if (typeof messageJson === 'string') {
                processStringData(messageJson);
                return;
            }

            if (messageJson.error) {
                logger.error(`Stream error REST: ${messageJson?.error?.message || 'unknown error'}`);
                safeUnsubscribe();
                finishStream(res, jsonResponse);
                return;
            }

            // Check if this is a streaming event with tool calls
            if (messageJson.choices && messageJson.choices[0] && messageJson.choices[0].delta) {
                const delta = messageJson.choices[0].delta;
                const finishReason = messageJson.choices[0].finish_reason;
                
                // Handle tool calls in streaming events
                if (delta.tool_calls) {
                    fillJsonResponseWithToolCalls(jsonResponse, delta.tool_calls, finishReason || "tool_calls");
                    sendStreamData(jsonResponse);
                    
                    if (finishReason === "tool_calls") {
        
                        safeUnsubscribe();
                        finishStream(res, jsonResponse);
                    }
                    return;
                }
                
                // Handle the case where we get an empty delta with finish_reason: "tool_calls"
                if (finishReason === "tool_calls" && Object.keys(delta).length === 0) {
    
                    safeUnsubscribe();
                    finishStream(res, jsonResponse);
                    return;
                }
                
                // Handle function calls in streaming events
                if (delta.function_call) {
                    // Ensure delta object exists
                    if (!jsonResponse.choices[0].delta) {
                        jsonResponse.choices[0].delta = {};
                    }
                    jsonResponse.choices[0].delta.function_call = delta.function_call;
                    jsonResponse.choices[0].finish_reason = finishReason || "function_call";
                    sendStreamData(jsonResponse);
                    
                    if (finishReason === "function_call") {
                        safeUnsubscribe();
                        finishStream(res, jsonResponse);
                    }
                    return;
                }
                
                // Handle regular content in streaming events
                if (delta.content !== undefined) {
                    if (delta.content === null) {
                        // Skip null content chunks
                        return;
                    }
                    chunkTextIntoTokens(delta.content, false, useSingleTokenStream).forEach(token => {
                        fillJsonResponse(jsonResponse, token, null);
                        sendStreamData(jsonResponse);
                    });
                    
                    if (finishReason === "stop") {
                        safeUnsubscribe();
                        finishStream(res, jsonResponse);
                    }
                    return;
                }
            }

            let content = '';
            if (messageJson.choices) {
                const { text, delta } = messageJson.choices[0];
                content = messageJson.object === 'text_completion' ? text : delta.content;
            } else if (messageJson.candidates) {
                content = messageJson.candidates[0].content.parts[0].text;
            } else if (messageJson.content) {
                content = messageJson.content?.[0]?.text || '';
            } else if (messageJson.tool_calls) {
                // Handle tool calls in streaming
                fillJsonResponseWithToolCalls(jsonResponse, messageJson.tool_calls, "tool_calls");
                sendStreamData(jsonResponse);
                safeUnsubscribe();
                finishStream(res, jsonResponse);
                return;
            } else {
                content = messageJson;
            }

            chunkTextIntoTokens(content, false, useSingleTokenStream).forEach(token => {
                fillJsonResponse(jsonResponse, token, null);
                sendStreamData(jsonResponse);
            });
        } catch (error) {
            logger.debug(`progressData not JSON: ${progressData}`);
            if (typeof progressData === 'string') {
                processStringData(progressData);
            } else {
                fillJsonResponse(jsonResponse, progressData, "stop");
                sendStreamData(jsonResponse);
            }
        }

        if (progress === 1) {
            safeUnsubscribe();
            finishStream(res, jsonResponse);
        }
    });

    // Fire the resolver for the async requestProgress
    logger.info(`Rest Endpoint starting async requestProgress, requestId: ${requestId}`);
    const { resolver, args } = requestState[requestId];
    requestState[requestId].useRedis = false;
    requestState[requestId].started = true;

    resolver && resolver(args);

    return subscription;
  
}

function buildRestEndpoints(pathways, app, server, config) {

    if (config.get('enableRestEndpoints')) {
        const openAIChatModels = {};
        const openAICompletionModels = {};

        // Create normal REST endpoints or emulate OpenAI API per pathway
        for (const [name, pathway] of Object.entries(pathways)) {
            // Only expose endpoints for enabled pathways that explicitly want to expose a REST endpoint
            if (pathway.disabled) continue;

            // The pathway can either emulate an OpenAI endpoint or be a normal REST endpoint
            if (pathway.emulateOpenAIChatModel || pathway.emulateOpenAICompletionModel) {
                if (pathway.emulateOpenAIChatModel) {
                    openAIChatModels[pathway.emulateOpenAIChatModel] = name;
                }
                if (pathway.emulateOpenAICompletionModel) {
                        openAICompletionModels[pathway.emulateOpenAICompletionModel] = name;
                }
            } else {
                app.post(`/rest/${name}`, async (req, res) => {
                    const pathwayResponse = await processRestRequest(server, req, pathway, name);
                    const { resultText } = extractResponseData(pathwayResponse);
                    res.send(resultText);
                });
            }
        }

        // Create OpenAI compatible endpoints
        app.post('/v1/completions', async (req, res) => {
            const modelName = req.body.model || 'gpt-3.5-turbo';
            const { pathwayName, isOllama } = resolveModelName(modelName, openAIChatModels, openAICompletionModels, false);

            if (!pathwayName) {
                handleModelNotFound(res, modelName);
                return;
            }

            if (isOllama) {
                req.body.ollamaModel = modelName.replace('ollama-', '');
            }

            const pathway = pathways[pathwayName];
            const parameterMap = { text: 'prompt' };
            const pathwayResponse = await processRestRequest(server, req, pathway, pathwayName, parameterMap);
            const { resultText } = extractResponseData(pathwayResponse);

            const jsonResponse = {
                id: `cmpl`,
                object: "text_completion",
                created: Date.now(),
                model: req.body.model,
                choices: [
                {
                    text: resultText,
                    index: 0,
                    logprobs: null,
                    finish_reason: "stop"
                }
                ],
            };

            // eslint-disable-next-line no-extra-boolean-cast
            if (Boolean(req.body.stream)) {
                jsonResponse.id = `cmpl-${resultText}`;
                jsonResponse.choices[0].finish_reason = null;
                processIncomingStream(resultText, res, jsonResponse, pathway);
            } else {
                jsonResponse.id = generateResponseId('cmpl');
                res.json(jsonResponse);
            }
        });
        
        app.post('/v1/chat/completions', async (req, res) => {
            const modelName = req.body.model || 'gpt-3.5-turbo';
            const { pathwayName, isOllama } = resolveModelName(modelName, openAIChatModels, openAICompletionModels, true);

            if (!pathwayName) {
                handleModelNotFound(res, modelName);
                return;
            }

            if (isOllama) {
                req.body.ollamaModel = modelName.replace('ollama-', '');
            }

            const pathway = pathways[pathwayName];
            const pathwayResponse = await processRestRequest(server, req, pathway, pathwayName);
            const { resultText, resultData } = extractResponseData(pathwayResponse);
            const { messageContent, toolCalls, functionCall, finishReason } = parseToolCalls(resultData, resultText);

            const jsonResponse = {
                id: `chatcmpl`,
                object: Boolean(req.body.stream) ? "chat.completion.chunk" : "chat.completion",
                created: Date.now(),
                model: req.body.model,
                choices: [
                    {
                        message: {
                            role: "assistant",
                            content: messageContent,
                            ...(toolCalls && { tool_calls: toolCalls }),
                            ...(functionCall && { function_call: functionCall })
                        },
                        index: 0,
                        finish_reason: finishReason
                    }
                ],
            };

            // eslint-disable-next-line no-extra-boolean-cast
            if (Boolean(req.body.stream)) {
                jsonResponse.id = `chatcmpl-${resultText}`;
                jsonResponse.choices[0].finish_reason = null;
                processIncomingStream(resultText, res, jsonResponse, pathway);
            } else {
                jsonResponse.id = generateResponseId('chatcmpl');
                res.json(jsonResponse);
            }
        });

        app.get('/v1/models', async (req, res) => {
            const openAIModels = { ...openAIChatModels, ...openAICompletionModels };
            const defaultModelId = 'gpt-3.5-turbo';
            let models = [];

            // Get standard OpenAI-compatible models, filtering out our internal pathway models
            models = Object.entries(openAIModels)
                .filter(([modelId]) => !['ollama-chat', 'ollama-completion'].includes(modelId))
                .map(([modelId]) => {
                    if (modelId.includes('*')) {
                        modelId = defaultModelId;
                    }
                    return {
                        id: modelId,
                        object: 'model',
                        owned_by: 'openai',
                        permission: '',
                    };
                });

            // Get Ollama models if configured
            if (config.get('ollamaUrl')) {
                const ollamaModels = await getOllamaModels(config.get('ollamaUrl'));
                models = [...models, ...ollamaModels];
            }

            // Filter out duplicates and sort
            models = models
                .filter((model, index, self) => {
                    return index === self.findIndex((m) => m.id === model.id);
                })
                .sort((a, b) => a.id.localeCompare(b.id));

            res.json({
                data: models,
                object: 'list',
            });
        });

    }
}

export { buildRestEndpoints };