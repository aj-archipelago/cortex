// rest.js
// Implement the REST endpoints for the pathways

import { json } from 'express';
import pubsub from './pubsub.js';
import { requestState } from './requestState.js';
import { v4 as uuidv4 } from 'uuid';


const processRestRequest = async (server, req, pathway, name, parameterMap = {}) => {
    const fieldVariableDefs = pathway.typeDef(pathway).restDefinition || [];

    const convertType = (value, type) => {
        if (type === 'Boolean') {
            return Boolean(value);
        } else if (type === 'Int') {
            return parseInt(value, 10);
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
    const resultText = result?.body?.singleResult?.data?.[name]?.result || result?.body?.singleResult?.errors?.[0]?.message || "";

    return resultText;
};

const processIncomingStream = (requestId, res, jsonResponse) => {

    const startStream = (res) => {
        // Set the headers for streaming
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
    }
    
    const finishStream = (res, jsonResponse) => {
    
        // Unsubscribe from the pubsub channel
        unsubscribe();

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
        //console.log(`REST SEND: data: ${JSON.stringify(data)}`);
        const dataString = (data==='[DONE]') ? data : JSON.stringify(data);

        if (!res.writableEnded) {
            res.write(`data: ${dataString}\n\n`);
        }
    }

    const fillJsonResponse = (jsonResponse, inputText, finishReason) => {

        jsonResponse.choices[0].finish_reason = finishReason;
        if (jsonResponse.object === 'text_completion') {
            jsonResponse.choices[0].text = inputText;
        } else {
            jsonResponse.choices[0].delta.content = inputText;
        }

        return jsonResponse;
    }

    startStream(res);

    let subscription;

    const unsubscribe = async () => {
        if (subscription) {
            try {
                pubsub.unsubscribe(await subscription);
            } catch (error) {
                console.error(`Error unsubscribing from pubsub: ${error}`);
            }
        }
    }

    subscription = pubsub.subscribe('REQUEST_PROGRESS', (data) => {
        if (data.requestProgress.requestId === requestId) {
            //console.log(`REQUEST_PROGRESS received progress: ${data.requestProgress.progress}, data: ${data.requestProgress.data}`);
            
            const progress = data.requestProgress.progress;
            const progressData = data.requestProgress.data;

            try {
                const messageJson = JSON.parse(progressData);
                if (messageJson.error) {
                    console.error(`Stream error REST:`, messageJson?.error?.message);
                    finishStream(res, jsonResponse);
                    return;
                } else if (messageJson.choices) {
                    const { text, delta, finish_reason } = messageJson.choices[0];

                    if (messageJson.object === 'text_completion') {
                        fillJsonResponse(jsonResponse, text, finish_reason);
                    } else {
                        fillJsonResponse(jsonResponse, delta.content, finish_reason);
                    }
                } else {
                    fillJsonResponse(jsonResponse, messageJson, null);
                }
            } catch (error) {
                //console.log(`progressData not JSON: ${progressData}`);
                fillJsonResponse(jsonResponse, progressData, "stop");
            }
            if (progress === 1 && progressData.trim() === "[DONE]") {
                finishStream(res, jsonResponse);
                return;
            }
            sendStreamData(jsonResponse);

            if (progress === 1) {
                finishStream(res, jsonResponse);
            }
        }
    });

    // Fire the resolver for the async requestProgress
    console.log(`Rest Endpoint starting async requestProgress, requestId: ${requestId}`);
    const { resolver, args } = requestState[requestId];
    resolver(args);

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

            if (Boolean(req.body.stream)) {
                jsonResponse.id = `cmpl-${resultText}`;
                jsonResponse.choices[0].finish_reason = null;
                //jsonResponse.object = "text_completion.chunk";

                const subscription = processIncomingStream(resultText, res, jsonResponse);
            } else {
                const requestId = uuidv4();
                jsonResponse.id = `cmpl-${requestId}`;
                res.json(jsonResponse);
            };
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

                const subscription = processIncomingStream(resultText, res, jsonResponse);
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
};

export { buildRestEndpoints };
