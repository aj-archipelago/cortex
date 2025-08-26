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

const processRestRequest = async (server, req, pathway, name, parameterMap = {}) => {
    const fieldVariableDefs = pathway.typeDef(pathway).restDefinition || [];

    const convertType = (value, type) => {
        if (type === 'Boolean') {
            return Boolean(value);
        } else if (type === 'Int') {
            return parseInt(value, 10);
        } else if (type === '[MultiMessage]' && Array.isArray(value)) {
            return value.map(msg => {
                // Special handling for messages with tool calls - don't convert content
                if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
                    return {
                        ...msg,
                        content: msg.content || null // Keep content as-is for tool call messages, null if empty
                    };
                }

                // Handle empty, null, or undefined content
                if (msg.content === "" || msg.content === null || msg.content === undefined) {
                    return {
                        ...msg,
                        content: msg.role === "assistant" && msg.tool_calls ? null : ""
                    };
                }

                // Handle string content - leave as string for OpenAI API
                if (typeof msg.content === 'string') {
                    return {
                        ...msg,
                        content: msg.content
                    };
                }

                // Handle array content - JSON.stringify each item as per original implementation
                if (Array.isArray(msg.content)) {
                    return {
                        ...msg,
                        content: msg.content.map(item => JSON.stringify(item))
                    };
                }

                // For any other type, convert to string
                return {
                    ...msg,
                    content: String(msg.content)
                };
            });
        } else if (type === '[Tool]' && Array.isArray(value)) {
            // Handle OpenAI tools parameter - accept stringified tool entries and stringify the parameters field
            return value.map(tool => {
                if (typeof tool === 'string') {
                    try { return JSON.parse(tool); } catch (e) { return tool; }
                }
                return {
                    ...tool,
                    function: tool.function ? {
                        ...tool.function,
                        parameters: typeof tool.function.parameters === 'object' ?
                            JSON.stringify(tool.function.parameters) :
                            tool.function.parameters
                    } : tool.function
                };
            });
        } else if (type === '[Function]' && Array.isArray(value)) {
            // Handle OpenAI functions parameter (legacy) - accept stringified entries and stringify the parameters field
            return value.map(func => {
                if (typeof func === 'string') {
                    try { return JSON.parse(func); } catch (e) { return func; }
                }
                return {
                    ...func,
                    parameters: typeof func.parameters === 'object' ?
                        JSON.stringify(func.parameters) :
                        func.parameters
                };
            });
        } else if (type === '[Message]' && Array.isArray(value)) {
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

    // For REST endpoints emulating OpenAI, ensure messages[].content are arrays of strings
    if (pathway?.emulateOpenAIChatModel || pathway?.emulateOpenAICompletionModel) {
        if (variables.messages && Array.isArray(variables.messages)) {
            variables.messages = variables.messages.map(m => {
                if (!m || typeof m !== 'object') return m;
                const c = m.content;
                if (Array.isArray(c)) {
                    const normalized = c.map(item => {
                        if (typeof item === 'string') return item;
                        if (item && typeof item === 'object') {
                            if (item.type === 'text' && typeof item.text === 'string') return item.text;
                            if (item.content && typeof item.content === 'string') return item.content;
                            return JSON.stringify(item);
                        }
                        return String(item);
                    });
                    return { ...m, content: normalized };
                }
                if (c && typeof c === 'object') {
                    if (c.type === 'text' && typeof c.text === 'string') return { ...m, content: [c.text] };
                    if (c.content && typeof c.content === 'string') return { ...m, content: [c.content] };
                    return { ...m, content: [JSON.stringify(c)] };
                }
                if (c === null || c === undefined) return { ...m, content: [] };
                return m;
            });
        }
    }

    // Minimal synchronous helper: ensure messages[].content are arrays of typed objects for OpenAI emulation
    const ensureMessagesTypedForOpenAI = (messages) => {
        if (!Array.isArray(messages)) return messages;
        const normalizeItem = (item) => {
            if (item === null || item === undefined) return { type: 'text', text: '' };
            if (typeof item === 'string') {
                try {
                    const p = JSON.parse(item);
                    if (p && typeof p === 'object') {
                        if (p.type) return p;
                        if (p.content || p.text) return { type: 'text', text: p.content ?? p.text };
                        return { type: 'text', text: JSON.stringify(p) };
                    }
                } catch (e) { }
                return { type: 'text', text: item };
            }
            if (typeof item === 'object') {
                if (item.type) return item;
                if (item.content || item.text) return { type: 'text', text: item.content ?? item.text };
                return { type: 'text', text: JSON.stringify(item) };
            }
            return { type: 'text', text: String(item) };
        };

        return messages.map((m) => {
            if (!m || typeof m !== 'object') return m;
            const content = m.content;
            if (Array.isArray(content)) return { ...m, content: content.map(normalizeItem) };
            if (typeof content === 'string') return { ...m, content: [normalizeItem(content)] };
            if (typeof content === 'object' && content !== null) return { ...m, content: [normalizeItem(content)] };
            return { ...m, content: [] };
        });
    };

    // Helpers for parsing tool/function parameters that may have been stringified
    const parseToolsParameter = (toolsParam) => {
        if (!toolsParam || !Array.isArray(toolsParam)) return toolsParam;
        return toolsParam.map(tool => {
            // Accept stringified tool entries
            if (typeof tool === 'string') {
                try { tool = JSON.parse(tool); } catch (e) { return tool; }
            }
            if (tool && typeof tool === 'object' && tool.function && typeof tool.function.parameters === 'string') {
                try {
                    return { ...tool, function: { ...tool.function, parameters: JSON.parse(tool.function.parameters) } };
                } catch (e) {
                    logger.warn(`Failed to parse tool function parameters: ${e.message}`);
                    return tool;
                }
            }
            return tool;
        });
    };

    const parseFunctionsParameter = (functionsParam) => {
        if (!functionsParam || !Array.isArray(functionsParam)) return functionsParam;
        return functionsParam.map(func => {
            // Accept stringified function entries
            if (typeof func === 'string') {
                try { func = JSON.parse(func); } catch (e) { return func; }
            }
            if (func && typeof func === 'object' && func.parameters && typeof func.parameters === 'string') {
                try {
                    return { ...func, parameters: JSON.parse(func.parameters) };
                } catch (e) {
                    logger.warn(`Failed to parse function parameters: ${e.message}`);
                    return func;
                }
            }
            return func;
        });
    };

    // Minimal message parsing for reasoning pathways: convert system->developer and stringify complex content
    const parseContentForReasoning = (content) => {
        if (typeof content === 'string') return [{ type: 'text', text: content }];
        if (Array.isArray(content)) return content.flat().map(item => ({ type: 'text', text: typeof item === 'string' ? item : JSON.stringify(item) }));
        return [{ type: 'text', text: content == null ? '' : String(content) }];
    };

    const tryParseMessagesForReasoning = (messages) => {
        if (!Array.isArray(messages)) return messages;
        return messages.map(m => {
            if (m.role === 'system') return { ...m, role: 'developer', content: parseContentForReasoning(m.content) };
            if (m.role === 'user' || m.role === 'assistant') return { ...m, content: parseContentForReasoning(m.content) };
            return m;
        });
    };

    // Minimal vision parsing: attempt to parse array items as JSON and normalize image entries
    const safeJsonParse = (v) => {
        try { return JSON.parse(v); } catch { return v; }
    };

    const tryParseMessagesForVision = async (messages) => {
        if (!Array.isArray(messages)) return messages;
        return await Promise.all(messages.map(async (m) => {
            try {
                if (Array.isArray(m.content)) {
                    const flat = m.content.flat();
                    const parsed = await Promise.all(flat.map(async item => {
                        const p = safeJsonParse(item);
                        if (p && typeof p === 'object' && (p.type === 'image' || p.type === 'image_url')) {
                            const url = p.url || p.image_url?.url;
                            if (url) return { type: 'image_url', image_url: { url } };
                        }
                        return typeof p === 'string' ? { type: 'text', text: p } : p;
                    }));
                    return { ...m, content: parsed };
                }
            } catch (e) {
                return m;
            }
            return m;
        }));
    };

    // Normalize known parameters before GraphQL execution
    if (variables.tools) variables.tools = parseToolsParameter(variables.tools);
    if (variables.functions) variables.functions = parseFunctionsParameter(variables.functions);
    if (variables.messages) {
        // Apply pathway-specific parsing first
        if (name && name.toLowerCase().includes('reason')) {
            variables.messages = tryParseMessagesForReasoning(variables.messages);
        } else if ((pathway && pathway.isMultiModal) || (name && name.toLowerCase().includes('vision'))) {
            variables.messages = await tryParseMessagesForVision(variables.messages);
        }

        // No coercion of message.content into typed objects here — keep GraphQL variables as strings/arrays
    }

    const variableParams = fieldVariableDefs.map(({ name, type }) => `$${name}: ${type}`).join(', ');
    const queryArgs = fieldVariableDefs.map(({ name }) => `${name}: $${name}`).join(', ');

    const query = `
            query ${name}(${variableParams}) {
                    ${name}(${queryArgs}) {
                        contextId
                        previousResult
                        result
                        tool
                    }
                }
            `;

    const result = await server.executeOperation({ query, variables });

    // if we're streaming and there are errors, we return a standard error code
    if (Boolean(req.body.stream)) {
        if (result?.body?.singleResult?.errors) {
            return `[ERROR] ${result.body.singleResult.errors[0].message.split(';')[0]}`;
        }
    }

    // otherwise errors can just be returned as a string
    let resultText = result?.body?.singleResult?.data?.[name]?.result || result?.body?.singleResult?.errors?.[0]?.message || "";
    const toolData = result?.body?.singleResult?.data?.[name]?.tool;

    // Ensure resultText is always a string for OpenAI API compatibility
    if (typeof resultText !== 'string') {
        resultText = JSON.stringify(resultText);
    }

    return { resultText, toolData };
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
        const dataString = (data === '[DONE]') ? data : JSON.stringify(data);

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
            jsonResponse.choices[0].delta.content = inputText;
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

            let content = '';
            if (messageJson.choices) {
                const { text, delta } = messageJson.choices[0];
                content = messageJson.object === 'text_completion' ? text : delta.content;
            } else if (messageJson.candidates) {
                content = messageJson.candidates[0].content.parts[0].text;
            } else if (messageJson.content) {
                content = messageJson.content?.[0]?.text || '';
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
                    const result = await processRestRequest(server, req, pathway, name);
                    const resultText = typeof result === 'string' ? result : result.resultText;
                    res.send(resultText);
                });
            }
        }

        // Create OpenAI compatible endpoints
        app.post('/v1/completions', async (req, res) => {
            const modelName = req.body.model || 'gpt-3.5-turbo';
            let pathwayName;

            if (modelName.startsWith('ollama-')) {
                pathwayName = 'sys_ollama_completion';
                req.body.ollamaModel = modelName.replace('ollama-', '');
            } else {
                pathwayName = openAICompletionModels[modelName] || openAICompletionModels['*'];
            }

            if (!pathwayName) {
                res.status(404).json({
                    error: `Model ${modelName} not found.`,
                });
                return;
            }

            const pathway = pathways[pathwayName];

            const parameterMap = {
                text: 'prompt'
            };

            const result = await processRestRequest(server, req, pathway, pathwayName, parameterMap);
            const resultText = typeof result === 'string' ? result : result.resultText;

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
                const requestId = uuidv4();
                jsonResponse.id = `cmpl-${requestId}`;
                res.json(jsonResponse);
            }
        });

        app.post('/v1/chat/completions', async (req, res) => {
            const modelName = req.body.model || 'gpt-3.5-turbo';
            let pathwayName;

            // Normalize incoming OpenAI-style messages so downstream plugins and outgoing
            // requests always receive content as arrays of typed objects when possible.
            const normalizeIncomingMessages = (messages) => {
                if (!Array.isArray(messages)) return messages;
                return messages.map((m) => {
                    if (!m || typeof m !== 'object') return m;
                    const content = m.content;

                    const normalizeItem = (item) => {
                        if (item === null || item === undefined) return { type: 'text', text: '' };
                        if (typeof item === 'string') {
                            // try parse JSON that may contain typed object
                            try {
                                const p = JSON.parse(item);
                                if (p && typeof p === 'object') {
                                    if (p.type) return p;
                                    if (p.content || p.text) return { type: 'text', text: p.content ?? p.text };
                                    return { type: 'text', text: JSON.stringify(p) };
                                }
                            } catch (e) {
                                // not JSON
                            }
                            return { type: 'text', text: item };
                        }
                        if (typeof item === 'object') {
                            if (item.type) return item;
                            if (item.content || item.text) return { type: 'text', text: item.content ?? item.text };
                            return { type: 'text', text: JSON.stringify(item) };
                        }
                        return { type: 'text', text: String(item) };
                    };

                    if (Array.isArray(content)) {
                        return { ...m, content: content.map(normalizeItem) };
                    }

                    if (typeof content === 'string') return { ...m, content: [normalizeItem(content)] };
                    if (typeof content === 'object' && content !== null) return { ...m, content: [normalizeItem(content)] };
                    return { ...m, content: [] };
                });
            };

            if (req.body && req.body.messages) {
                req.body.messages = normalizeIncomingMessages(req.body.messages);
            }

            if (modelName.startsWith('ollama-')) {
                pathwayName = 'sys_ollama_chat';
                req.body.ollamaModel = modelName.replace('ollama-', '');
            } else {
                pathwayName = openAIChatModels[modelName] || openAIChatModels['*'];
            }

            if (!pathwayName) {
                res.status(404).json({
                    error: `Model ${modelName} not found.`,
                });
                return;
            }

            const pathway = pathways[pathwayName];

            const result = await processRestRequest(server, req, pathway, pathwayName);
            let resultText = typeof result === 'string' ? result : result.resultText;
            const toolData = typeof result === 'object' ? result.toolData : null;

            // Handle JSON parsing for different formats - clean up wrappers but keep as string
            if (typeof resultText === 'string') {
                // Handle JSON wrapped in code blocks - extract the clean JSON
                if (resultText.startsWith('```json') && resultText.endsWith('```')) {
                    try {
                        const jsonContent = resultText.slice(8, -3).trim();
                        // Parse to validate it's valid JSON, then stringify back to clean string
                        const parsedJson = JSON.parse(jsonContent);
                        resultText = JSON.stringify(parsedJson);
                    } catch (e) {
                        logger.warn(`Failed to parse resultText from code block as JSON: ${e.message}`);
                    }
                }
                // Note: We don't auto-parse plain JSON strings since they might be intended as plain text
            }

            // Ensure resultText is always a string for OpenAI API compatibility
            if (typeof resultText !== 'string') {
                resultText = JSON.stringify(resultText);
            }

            const jsonResponse = {
                id: `chatcmpl`,
                object: "chat.completion",
                created: Date.now(),
                model: req.body.model,
                choices: [
                    {
                        message: {
                            role: "assistant",
                            content: resultText
                        },
                        index: 0,
                        finish_reason: "stop"
                    }
                ],
            };

            // Handle tool calls if present
            if (toolData) {
                try {
                    const toolJson = JSON.parse(toolData);
                    if (toolJson.passthrough_tool_calls && Array.isArray(toolJson.passthrough_tool_calls)) {
                        jsonResponse.choices[0].message.tool_calls = toolJson.passthrough_tool_calls;
                        // Ensure content is a string to avoid sending raw objects to model endpoints
                        jsonResponse.choices[0].message.content = (typeof toolJson.content === 'string') ? toolJson.content : JSON.stringify(toolJson.content || '');
                    }
                } catch (e) {
                    logger.warn(`Failed to parse tool data: ${e.message}`);
                }
            }

            // eslint-disable-next-line no-extra-boolean-cast
            if (Boolean(req.body.stream)) {
                jsonResponse.id = `chatcmpl-${resultText}`;
                jsonResponse.choices[0] = {
                    delta: {
                        role: "assistant",
                        content: resultText
                    },
                    finish_reason: null
                }
                jsonResponse.object = "chat.completion.chunk";

                processIncomingStream(resultText, res, jsonResponse, pathway);
            } else {
                const requestId = uuidv4();
                jsonResponse.id = `chatcmpl-${requestId}`;


                // Always return OpenAI format for /v1/chat/completions endpoint
                res.json(jsonResponse);
            }

        });

        /*
        // Alias /v1/messages to use the same logic as /v1/chat/completions
        app.post('/v1/messages', (req, res) => {
            // Forward to the chat completions endpoint logic
            // Note: This is a workaround to allow /v1/messages to work like /v1/chat/completions
            req.body.model = 'claude-3.7-sonnet';
            app._router.handle({ ...req, url: '/v1/chat/completions', originalUrl: '/v1/messages' }, res);
        });
        */

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