// rest.js
// Implement the REST endpoints for the pathways

import pubsub from './pubsub.js';
import { requestState } from './requestState.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../lib/logger.js';
import { getSingleTokenChunks } from './chunker.js';

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
            return value.map(msg => ({
                ...msg,
                content: Array.isArray(msg.content) ? 
                    JSON.stringify(msg.content) : 
                    msg.content
            }));
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

    const variableParams = fieldVariableDefs.map(({ name, type }) => `$${name}: ${type}`).join(', ');
    const queryArgs = fieldVariableDefs.map(({ name }) => `${name}: $${name}`).join(', ');

    const query = `
            query ${name}(${variableParams}) {
                    ${name}(${queryArgs}) {
                        contextId
                        previousResult
                        result
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
    const resultText = result?.body?.singleResult?.data?.[name]?.result || result?.body?.singleResult?.errors?.[0]?.message || "";
    return resultText;
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
                    const resultText = await processRestRequest(server, req, pathway, name);
                    res.send(resultText);
                });
            }
        }

        // Create OpenAI compatible endpoints
        app.post('/v1/completions', async (req, res) => {
            const modelName = req.body.model || 'gpt-3.5-turbo';
            const pathwayName = openAICompletionModels[modelName] || openAICompletionModels['*'];

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

            const resultText = await processRestRequest(server, req, pathway, pathwayName, parameterMap);

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
                //jsonResponse.object = "text_completion.chunk";

                processIncomingStream(resultText, res, jsonResponse, pathway);
            } else {
                const requestId = uuidv4();
                jsonResponse.id = `cmpl-${requestId}`;
                res.json(jsonResponse);
            }
        });
        
        app.post('/v1/chat/completions', async (req, res) => {
            const modelName = req.body.model || 'gpt-3.5-turbo';
            const pathwayName = openAIChatModels[modelName] || openAIChatModels['*'];

            if (!pathwayName) {
                res.status(404).json({
                    error: `Model ${modelName} not found.`,
                });
                return;
            }

            const pathway = pathways[pathwayName];

            const resultText = await processRestRequest(server, req, pathway, pathwayName);

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

                res.json(jsonResponse);
            }

        });

        app.get('/v1/models', async (req, res) => {
            const openAIModels = { ...openAIChatModels, ...openAICompletionModels };
            const defaultModelId = 'gpt-3.5-turbo';

            const models = Object.entries(openAIModels)
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
                })
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