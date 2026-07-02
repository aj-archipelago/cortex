// rest/openaiCompletionsRoute.js
// POST /v1/completions and POST /v1/chat/completions endpoints + shared OpenAI SSE streaming

import pubsub from '../pubsub.js';
import { v4 as uuidv4 } from 'uuid';
import { createParser } from 'eventsource-parser';
import logger from '../../lib/logger.js';
import { processRestRequest } from './processRestRequest.js';
import {
    startSSEStream,
    safeUnsubscribe,
    fireStreamResolver,
    resolveModelName,
    handleModelNotFound,
    extractResponseData,
    extractPathwayErrorMessage,
    parseToolCalls,
    generateResponseId,
    logTokenUsage,
    setupPassthroughStreaming,
} from './restUtils.js';
import { modelEndpoints, selectEndpoint, axios } from '../../lib/requestExecutor.js';

// Model types whose upstream natively speaks the OpenAI chat completions protocol
// and can be passed through without conversion.
const CHAT_PASSTHROUGH_MODEL_TYPES = ['OPENAI-CHAT', 'OPENAI-VISION', 'OPENAI-REASONING-VISION', 'KIMI-CHAT'];

const isChatPassthroughModel = (pathwayModelName) => {
    const model = modelEndpoints[pathwayModelName];
    return model && CHAT_PASSTHROUGH_MODEL_TYPES.includes(model.type);
};

const getChatPassthroughModelName = (model, endpoint) => {
    return endpoint?.params?.model || model.params?.model || model.emulateOpenAIChatModel || model.name;
};

const sendOpenAIError = (res, message, status = 502, type = 'server_error') => {
    res.status(status).json({
        error: {
            message,
            type,
        }
    });
};

/**
 * Native passthrough for chat-completions models — streams SSE directly without
 * pathway machinery. Mirrors handleResponsesPassthrough / handleClaudePassthrough.
 */
const handleChatCompletionsPassthrough = async (req, res, pathwayModelName) => {
    const requestId = uuidv4();
    const model = modelEndpoints[pathwayModelName];
    const endpoint = selectEndpoint(model);

    if (!endpoint) {
        res.status(500).json({
            error: { type: 'server_error', message: 'No endpoint available for model' }
        });
        return;
    }

    const isStreaming = Boolean(req.body.stream);
    const requestBody = { ...req.body };

    const upstreamModelName = getChatPassthroughModelName(model, endpoint);
    if (upstreamModelName) {
        requestBody.model = upstreamModelName;
    }

    const url = endpoint.url;
    const headers = {
        'Content-Type': 'application/json',
        ...endpoint.headers
    };

    logger.info(`[${requestId}] Chat completions passthrough: ${model.type} ${isStreaming ? 'streaming' : 'non-streaming'}`);

    const abortController = new AbortController();

    try {
        const response = await endpoint.limiter.schedule({ id: requestId }, async () => {
            return axios({
                method: 'POST',
                url,
                headers,
                data: requestBody,
                responseType: isStreaming ? 'stream' : 'json',
                timeout: 600000,
                signal: abortController.signal
            });
        });

        if (!isStreaming) {
            logTokenUsage({
                req,
                usage: response.data?.usage,
                model: response.data?.model || upstreamModelName,
                route: req.path,
                requestId
            });
            res.json(response.data);
            return;
        }

        startSSEStream(res);

        let usageLogged = false;
        const onParse = (event) => {
            if (event.type !== 'event') return;
            if (res.writableEnded) return;

            const data = event.data;

            // Forward terminal sentinel verbatim
            if (data === '[DONE]') {
                res.write(`data: [DONE]\n\n`);
                return;
            }

            // Capture usage when present (final chunk if stream_options.include_usage=true)
            if (!usageLogged) {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed?.usage) {
                        logTokenUsage({
                            req,
                            usage: parsed.usage,
                            model: parsed.model || upstreamModelName,
                            route: req.path,
                            requestId
                        });
                        usageLogged = Boolean(req._cortexUsageLogged);
                    }
                } catch {
                    // non-JSON data line; forward as-is
                }
            }

            res.write(`data: ${data}\n\n`);
        };

        const sseParser = createParser(onParse);

        setupPassthroughStreaming({
            req,
            res,
            incomingMessage: response.data,
            sseParser,
            abortController,
            requestId,
            logPrefix: 'Chat completions'
        });

    } catch (error) {
        const status = error.response?.status || 500;
        let errorData;
        if (error.response?.data && typeof error.response.data === 'object') {
            errorData = {
                type: error.response.data.error?.type || 'error',
                message: error.response.data.error?.message || error.response.data.message || error.message
            };
        } else {
            errorData = { type: 'error', message: error.message };
        }

        logger.error(`[${requestId}] Chat completions passthrough error: ${status} ${errorData.message}`);

        if (isStreaming && !res.headersSent) {
            startSSEStream(res);
            res.write(`data: ${JSON.stringify({ error: errorData })}\n\n`);
            res.write(`data: [DONE]\n\n`);
            res.end();
        } else if (!res.headersSent) {
            res.status(status).json({ error: errorData });
        }
    }
};

const processIncomingStream = (requestId, req, res, jsonResponse, pathway, modelName) => {
    let latestUsage = null;
    const finishStream = (res, jsonResponse) => {
        logTokenUsage({
            req,
            usage: latestUsage,
            model: modelName,
            route: req?.path,
            requestId
        });
        // If we haven't sent the stop message yet, do it now
        if (jsonResponse.choices?.[0]?.finish_reason == null) {
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

    const fillJsonResponse = (jsonResponse, inputText) => {
        jsonResponse.choices[0].finish_reason = null;
        if (jsonResponse.object === 'text_completion') {
            jsonResponse.choices[0].text = inputText;
        } else {
            if (!jsonResponse.choices[0].delta) {
                jsonResponse.choices[0].delta = {};
            }
            jsonResponse.choices[0].delta.content = inputText;
        }

        return jsonResponse;
    }

    const fillJsonResponseWithToolCalls = (jsonResponse, toolCalls, finishReason) => {
        jsonResponse.choices[0].finish_reason = finishReason ?? null;
        if (jsonResponse.object !== 'text_completion') {
            if (!jsonResponse.choices[0].delta) {
                jsonResponse.choices[0].delta = {};
            }
            jsonResponse.choices[0].delta.tool_calls = toolCalls;
        }
        return jsonResponse;
    }

    startSSEStream(res);

    // If the requestId is an error message, we can't continue
    if (requestId.startsWith('[ERROR]')) {
        fillJsonResponse(jsonResponse, requestId);
        sendStreamData(jsonResponse);
        finishStream(res, jsonResponse);
        return;
    }

    let subscription;

    subscription = pubsub.subscribe('REQUEST_PROGRESS', (data) => {

        const processStringData = (stringData) => {
            if (progress === 1 && stringData.trim() === "[DONE]") {
                fillJsonResponse(jsonResponse, stringData);
                safeUnsubscribe(subscription);
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
                    safeUnsubscribe(subscription);
                    finishStream(res, jsonResponse);
                    return;
                }
            } catch (e) {
                // Not JSON, treat as regular text
            }

            fillJsonResponse(jsonResponse, stringData);
            sendStreamData(jsonResponse);

            if (progress === 1) {
                safeUnsubscribe(subscription);
                finishStream(res, jsonResponse);
            }

        }

        if (data.requestProgress.requestId !== requestId) return;

        logger.debug(`REQUEST_PROGRESS received progress: ${data.requestProgress.progress}, data: ${data.requestProgress.data}`);

        const { progress, data: progressData, error: progressError } = data.requestProgress;

        try {
            if (progressError) {
                logger.error(`Stream error REST: ${progressError}`);
                fillJsonResponse(jsonResponse, `[ERROR] ${progressError}`);
                sendStreamData(jsonResponse);
                safeUnsubscribe(subscription);
                finishStream(res, jsonResponse);
                return;
            }

            const messageJson = JSON.parse(progressData);

            if (typeof messageJson === 'string') {
                processStringData(messageJson);
                return;
            }

            if (messageJson.error) {
                const errorMessage = messageJson?.error?.message || messageJson?.error || 'unknown error';
                logger.error(`Stream error REST: ${errorMessage}`);
                fillJsonResponse(jsonResponse, `[ERROR] ${errorMessage}`);
                sendStreamData(jsonResponse);
                safeUnsubscribe(subscription);
                finishStream(res, jsonResponse);
                return;
            }

            if (messageJson.usage) {
                latestUsage = messageJson.usage;
            }

            // Check if this is a streaming event with tool calls
            if (messageJson.choices && messageJson.choices[0] && messageJson.choices[0].delta) {
                const delta = messageJson.choices[0].delta;
                const finishReason = messageJson.choices[0].finish_reason;

                // Handle tool calls in streaming events
                if (delta.tool_calls) {
                    fillJsonResponseWithToolCalls(jsonResponse, delta.tool_calls, finishReason);
                    sendStreamData(jsonResponse);

                    if (finishReason === "tool_calls" || progress === 1) {
                        safeUnsubscribe(subscription);
                        finishStream(res, jsonResponse);
                    }
                    return;
                }

                // Handle the case where we get an empty delta with finish_reason: "tool_calls"
                if (
                    (finishReason === "tool_calls" || finishReason === "function_call") &&
                    Object.keys(delta).length === 0
                ) {
                    jsonResponse.choices[0].finish_reason = finishReason;
                    jsonResponse.choices[0].delta = {};
                    sendStreamData(jsonResponse);
                    safeUnsubscribe(subscription);
                    finishStream(res, jsonResponse);
                    return;
                }

                // Handle function calls in streaming events
                if (delta.function_call) {
                    if (!jsonResponse.choices[0].delta) {
                        jsonResponse.choices[0].delta = {};
                    }
                    jsonResponse.choices[0].delta.function_call = delta.function_call;
                    jsonResponse.choices[0].finish_reason = finishReason ?? null;
                    sendStreamData(jsonResponse);

                    if (finishReason === "function_call") {
                        safeUnsubscribe(subscription);
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
                    fillJsonResponse(jsonResponse, delta.content);
                    sendStreamData(jsonResponse);

                    if (finishReason === "stop") {
                        safeUnsubscribe(subscription);
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
                safeUnsubscribe(subscription);
                finishStream(res, jsonResponse);
                return;
            } else {
                content = messageJson;
            }

            fillJsonResponse(jsonResponse, content);
            sendStreamData(jsonResponse);
        } catch (error) {
            logger.debug(`progressData not JSON: ${progressData}`);
            if (typeof progressData === 'string') {
                processStringData(progressData);
            } else {
                fillJsonResponse(jsonResponse, progressData);
                sendStreamData(jsonResponse);
            }
        }

        if (progress === 1) {
            safeUnsubscribe(subscription);
            finishStream(res, jsonResponse);
        }
    });

    // Fire the resolver for the async requestProgress
    logger.info(`Rest Endpoint starting async requestProgress, requestId: ${requestId}`);
    fireStreamResolver(requestId);

    return subscription;

}

function registerOpenAICompletionsRoute(app, pathways, openAIChatModels, openAICompletionModels, server) {
    // POST /v1/completions
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
        const pathwayError = extractPathwayErrorMessage(pathwayResponse);
        if (pathwayError) {
            sendOpenAIError(res, pathwayError);
            return;
        }
        const { resultText, resultData } = extractResponseData(pathwayResponse);
        const { usage } = parseToolCalls(resultData, resultText);

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
            processIncomingStream(resultText, req, res, jsonResponse, pathway, modelName);
        } else {
            jsonResponse.id = generateResponseId('cmpl');
            logTokenUsage({
                req,
                usage,
                model: modelName,
                route: req.path,
                requestId: jsonResponse.id
            });
            res.json(jsonResponse);
        }
    });

    // POST /v1/chat/completions
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
        const pathwayModelName = pathway?.model;

        // Native passthrough for chat-completion-protocol models — preserves full
        // request fidelity (no static token caps, all native params forwarded).
        if (pathwayModelName && isChatPassthroughModel(pathwayModelName)) {
            logger.debug(`Using native chat completions passthrough for ${pathwayModelName}`);
            await handleChatCompletionsPassthrough(req, res, pathwayModelName);
            return;
        }

        const pathwayResponse = await processRestRequest(server, req, pathway, pathwayName);
        const pathwayError = extractPathwayErrorMessage(pathwayResponse);
        if (pathwayError) {
            sendOpenAIError(res, pathwayError);
            return;
        }
        const { resultText, resultData } = extractResponseData(pathwayResponse);
        const { messageContent, toolCalls, functionCall, finishReason, usage } = parseToolCalls(resultData, resultText);

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
            processIncomingStream(resultText, req, res, jsonResponse, pathway, modelName);
        } else {
            jsonResponse.id = generateResponseId('chatcmpl');
            logTokenUsage({
                req,
                usage,
                model: modelName,
                route: req.path,
                requestId: jsonResponse.id
            });
            res.json(jsonResponse);
        }
    });
}

export { registerOpenAICompletionsRoute };
