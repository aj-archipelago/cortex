// rest/openaiResponsesRoute.js
// POST /v1/responses endpoint + Responses API conversions + Responses SSE streaming

import pubsub from '../pubsub.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../lib/logger.js';
import { processRestRequest } from './processRestRequest.js';
import {
    startSSEStream,
    safeUnsubscribe,
    fireStreamResolver,
    resolveModelName,
    handleModelNotFound,
    extractResponseData,
    normalizeUsage,
    normalizeResponseOutputText,
    parseToolCalls,
    generateResponseId,
    setupPassthroughStreaming,
    logTokenUsage,
} from './restUtils.js';
import { modelEndpoints, selectEndpoint, axios, buildLimiterScheduleOptions } from '../../lib/requestExecutor.js';
import { createParser } from 'eventsource-parser';

// Model types that support native Responses API passthrough (no conversion needed)
const RESPONSES_MODEL_TYPES = ['OPENAI-RESPONSES'];

/**
 * Check if a model supports native Responses API passthrough (no conversion needed)
 */
const isResponsesModel = (pathwayModelName) => {
    const model = modelEndpoints[pathwayModelName];
    return model && RESPONSES_MODEL_TYPES.includes(model.type);
};

/**
 * Get the model name to send to the Responses API
 */
const getResponsesModelName = (model, endpoint) => {
    return endpoint?.params?.model || model.params?.model || model.emulateOpenAIChatModel || model.name;
};

/**
 * Native passthrough for Responses API models - streams SSE directly without conversion
 */
const handleResponsesPassthrough = async (req, res, pathwayModelName) => {
    const requestId = uuidv4();
    const model = modelEndpoints[pathwayModelName];
    const endpoint = selectEndpoint(model);

    if (!endpoint) {
        res.status(500).json({
            error: { type: "server_error", message: "No endpoint available for model" }
        });
        return;
    }

    const isStreaming = Boolean(req.body.stream);

    // Build the request - minimal transformation, just pass through
    const requestBody = { ...req.body };

    // Ensure model is set in request body
    const modelName = getResponsesModelName(model, endpoint);
    if (modelName) {
        requestBody.model = modelName;
    }

    // Build URL and headers
    const url = endpoint.url;
    const headers = {
        'Content-Type': 'application/json',
        ...endpoint.headers
    };

    logger.info(`[${requestId}] Responses API passthrough: ${model.type} ${isStreaming ? 'streaming' : 'non-streaming'}`);

    const abortController = new AbortController();

    try {
        // Rate limit via endpoint limiter
        const response = await endpoint.limiter.schedule(buildLimiterScheduleOptions(requestId), async () => {
            return axios({
                method: 'POST',
                url,
                headers,
                data: requestBody,
                responseType: isStreaming ? 'stream' : 'json',
                timeout: 600000, // 10 minute timeout for long responses
                signal: abortController.signal
            });
        });

        if (!isStreaming) {
            // Non-streaming: just return the response
            logTokenUsage({
                req,
                usage: response.data?.usage,
                model: response.data?.model || modelName,
                route: req.path,
                requestId
            });
            res.json(response.data);
            return;
        }

        // Streaming: pipe SSE directly to client
        startSSEStream(res);

        const incomingMessage = response.data;

        // Set up SSE parser to forward events
        let usageLogged = false;
        const onParse = (event) => {
            if (event.type === 'event') {
                if (!usageLogged && event.data) {
                    try {
                        const parsed = JSON.parse(event.data);
                        const eventType = parsed?.type;
                        if (
                            eventType === 'response.completed' ||
                            eventType === 'response.done' ||
                            eventType === 'response.failed' ||
                            eventType === 'response.cancelled'
                        ) {
                            const usage = parsed.response?.usage || parsed.usage;
                            logTokenUsage({
                                req,
                                usage,
                                model: parsed.response?.model || parsed.model || modelName,
                                route: req.path,
                                requestId
                            });
                            usageLogged = Boolean(req._cortexUsageLogged);
                        }
                    } catch {
                        // ignore non-JSON events
                    }
                }
                // Forward the raw SSE event directly - no conversion needed!
                if (!res.writableEnded) {
                    res.write(`event: ${event.event || 'message'}\n`);
                    res.write(`data: ${event.data}\n\n`);
                }
            }
        };

        const sseParser = createParser(onParse);

        setupPassthroughStreaming({
            req,
            res,
            incomingMessage,
            sseParser,
            abortController,
            requestId,
            logPrefix: 'Responses API'
        });

    } catch (error) {
        const status = error.response?.status || 500;
        // Safely extract error data - avoid circular references from axios response objects
        let errorData;
        if (error.response?.data && typeof error.response.data === 'object') {
            errorData = {
                type: error.response.data.type || 'error',
                message: error.response.data.error?.message || error.response.data.message || error.message
            };
        } else {
            errorData = { type: 'error', message: error.message };
        }

        logger.error(`[${requestId}] Responses API passthrough error: ${status} ${errorData.message}`);

        if (isStreaming && !res.headersSent) {
            startSSEStream(res);
            res.write(`event: error\n`);
            res.write(`data: ${JSON.stringify({ type: "error", error: errorData })}\n\n`);
            res.end();
        } else if (!res.headersSent) {
            res.status(status).json({
                error: errorData
            });
        }
    }
};

const stringifyIfNeeded = (value) => {
    if (typeof value === "string") return value;
    if (value == null) return "";
    try {
        return JSON.stringify(value);
    } catch (err) {
        return String(value);
    }
};

const ensureResponseUsage = (usage) => {
    const normalizedUsage = normalizeUsage(usage) || {};
    const inputTokens = normalizedUsage.input_tokens ?? 0;
    const outputTokens = normalizedUsage.output_tokens ?? 0;
    const totalTokens = normalizedUsage.total_tokens ?? (inputTokens + outputTokens);

    return {
        ...normalizedUsage,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens
    };
};

const normalizeResponsesRole = (role) => {
    if (role === "developer") return "system";
    return role || "user";
};

const normalizeResponsesContent = (content) => {
    if (content == null) return "";
    if (typeof content === "string") return content;

    if (Array.isArray(content)) {
        return content
            .map((item) => {
                if (typeof item === "string") return item;
                if (!item || typeof item !== "object") return stringifyIfNeeded(item);
                if (item.type === "input_text" || item.type === "text" || item.type === "output_text") {
                    return item.text || "";
                }
                return stringifyIfNeeded(item);
            })
            .filter((part) => part !== "")
            .join("\n")
            .trim();
    }

    if (typeof content === "object" && typeof content.text === "string") {
        return content.text;
    }

    return stringifyIfNeeded(content);
};

const convertResponsesItemToMessage = (item) => {
    if (typeof item === "string") {
        return { role: "user", content: item };
    }

    if (!item || typeof item !== "object") {
        return { role: "user", content: stringifyIfNeeded(item) };
    }

    if (item.type === "function_call_output") {
        return {
            role: "tool",
            tool_call_id: item.call_id || item.tool_call_id || item.id || `call_${Date.now()}`,
            content: normalizeResponsesContent(item.output ?? "")
        };
    }

    if (item.type === "function_call") {
        return {
            role: "assistant",
            content: "",
            tool_calls: [
                {
                    id: item.call_id || item.id || `call_${Date.now()}`,
                    type: "function",
                    function: {
                        name: item.name || "",
                        arguments: typeof item.arguments === "string" ? item.arguments : stringifyIfNeeded(item.arguments ?? {})
                    }
                }
            ]
        };
    }

    const normalizedMessage = {
        role: normalizeResponsesRole(item.role),
        content: normalizeResponsesContent(item.content ?? item.input ?? "")
    };

    if (item.name) {
        normalizedMessage.name = item.name;
    }
    if (item.tool_calls) {
        normalizedMessage.tool_calls = item.tool_calls;
    }
    if (item.tool_call_id) {
        normalizedMessage.tool_call_id = item.tool_call_id;
    }

    return normalizedMessage;
};

const normalizeResponsesMessages = (messages) => {
    if (messages == null) return messages;
    if (!Array.isArray(messages)) {
        return [convertResponsesItemToMessage(messages)];
    }
    return messages
        .map((item) => convertResponsesItemToMessage(item))
        .filter((message) => message && message.role);
};

const convertResponsesInputToMessages = (input) => {
    if (Array.isArray(input)) {
        return normalizeResponsesMessages(input);
    }
    return [convertResponsesItemToMessage(input)];
};

const serializeResponsesInput = (value) => {
    if (value === undefined) return undefined;
    try {
        return JSON.stringify(value);
    } catch (err) {
        return JSON.stringify(stringifyIfNeeded(value));
    }
};

// Process streaming for OpenAI Responses API format
const processIncomingResponsesStream = (requestId, req, res, pathway, modelName, responseId) => {
    let responseCreatedSent = false;
    let textOutputStarted = false;
    const responseCreatedAt = Math.floor(Date.now() / 1000);
    const responseMessageId = `msg_${uuidv4()}`;
    const completedFunctionCalls = [];
    let nextOutputIndex = 0;
    let textOutputIndex = -1;
    // Map upstream output_index → local output_index for function call events
    const upstreamIndexMap = new Map();
    // Track chat completion format tool calls (delta.tool_calls chunks)
    const chatToolCalls = new Map(); // index → {id, name, arguments}
    const chatToolCallIndexMap = new Map(); // index → local output_index

    const sendEvent = (event, data) => {
        if (res.writableEnded) return;
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const ensureResponseCreated = () => {
        if (responseCreatedSent) return;
        responseCreatedSent = true;
        sendEvent("response.created", {
            type: "response.created",
            response: {
                id: responseId,
                object: "response",
                created_at: responseCreatedAt,
                status: "in_progress",
                model: modelName,
                output: []
            }
        });
    };

    // Lazily set up the text message output scaffold on first text content
    const ensureTextOutput = () => {
        ensureResponseCreated();
        if (textOutputStarted) return;
        textOutputStarted = true;
        textOutputIndex = nextOutputIndex++;
        sendEvent("response.output_item.added", {
            type: "response.output_item.added",
            output_index: textOutputIndex,
            item: {
                type: "message",
                id: responseMessageId,
                status: "in_progress",
                role: "assistant",
                content: []
            }
        });
        sendEvent("response.content_part.added", {
            type: "response.content_part.added",
            item_index: 0,
            output_index: textOutputIndex,
            content_index: 0,
            part: {
                type: "output_text",
                text: "",
                annotations: []
            }
        });
    };

    const sendTextDelta = (text) => {
        if (!text) return;
        ensureTextOutput();
        sendEvent("response.output_text.delta", {
            type: "response.output_text.delta",
            item_index: 0,
            output_index: textOutputIndex,
            content_index: 0,
            delta: text
        });
    };

    const mapOutputIndex = (upstreamIndex) => {
        if (upstreamIndexMap.has(upstreamIndex)) return upstreamIndexMap.get(upstreamIndex);
        return upstreamIndex;
    };

    const finishStream = (outputText, usage = null) => {
        const output = [];

        // Close text output if started
        if (textOutputStarted) {
            sendEvent("response.content_part.done", {
                type: "response.content_part.done",
                item_index: 0,
                output_index: textOutputIndex,
                content_index: 0,
                part: {
                    type: "output_text",
                    text: outputText,
                    annotations: []
                }
            });
            sendEvent("response.output_item.done", {
                type: "response.output_item.done",
                output_index: textOutputIndex,
                item: {
                    type: "message",
                    id: responseMessageId,
                    status: "completed",
                    role: "assistant",
                    content: [{
                        type: "output_text",
                        text: outputText,
                        annotations: []
                    }]
                }
            });
            output.push({
                type: "message",
                id: responseMessageId,
                status: "completed",
                role: "assistant",
                content: [{
                    type: "output_text",
                    text: outputText,
                    annotations: []
                }]
            });
        }

        // Include completed function calls
        for (const fc of completedFunctionCalls) {
            output.push(fc);
        }

        sendEvent("response.done", {
            type: "response.done",
            response: {
                id: responseId,
                object: "response",
                created_at: responseCreatedAt,
                status: "completed",
                model: modelName,
                output,
                output_text: outputText || '',
                usage: ensureResponseUsage(usage)
            }
        });
        res.end();
    };

    startSSEStream(res);

    if (requestId.startsWith('[ERROR]')) {
        ensureTextOutput();
        sendTextDelta(requestId);
        finishStream(requestId);
        return;
    }

    let subscription;
    let contentBuffer = '';

    subscription = pubsub.subscribe('REQUEST_PROGRESS', (data) => {
        if (data.requestProgress.requestId !== requestId) return;

        const { progress, data: progressData } = data.requestProgress;

        const finish = (usage = null) => {
            logTokenUsage({
                req,
                usage,
                model: modelName,
                route: req?.path,
                requestId
            });
            finishStream(contentBuffer, usage);
            safeUnsubscribe(subscription);
        };

        const processString = (text) => {
            if (!text) {
                if (progress === 1) {
                    finish();
                }
                return;
            }
            ensureResponseCreated();
            contentBuffer += text;
            sendTextDelta(text);
            if (progress === 1) {
                finish();
            }
        };

        try {
            const messageJson = JSON.parse(progressData);
            if (typeof messageJson === "string") {
                processString(messageJson);
                return;
            }

            if (messageJson?.error) {
                ensureResponseCreated();
                const errorMsg = messageJson.error?.message || "Stream error";
                sendTextDelta(errorMsg);
                contentBuffer += errorMsg;
                finish();
                return;
            }

            if (typeof messageJson.type === 'string') {
                const eventType = messageJson.type;

                // Native Responses API SSE events (response.*)
                if (eventType.startsWith('response.')) {
                    ensureResponseCreated();

                    // --- Text output events ---
                    if (eventType === 'response.output_text.delta') {
                        const delta = typeof messageJson.delta === 'string'
                            ? messageJson.delta
                            : '';
                        if (delta) {
                            contentBuffer += delta;
                            sendTextDelta(delta);
                        }
                        return;
                    }

                    // --- Function call events: pass through to client ---
                    if (eventType === 'response.output_item.added' && messageJson.item?.type === 'function_call') {
                        const localIndex = nextOutputIndex++;
                        upstreamIndexMap.set(messageJson.output_index, localIndex);
                        sendEvent(eventType, {
                            ...messageJson,
                            output_index: localIndex
                        });
                        return;
                    }

                    if (eventType === 'response.function_call_arguments.delta') {
                        sendEvent(eventType, {
                            ...messageJson,
                            output_index: mapOutputIndex(messageJson.output_index)
                        });
                        return;
                    }

                    if (eventType === 'response.function_call_arguments.done') {
                        sendEvent(eventType, {
                            ...messageJson,
                            output_index: mapOutputIndex(messageJson.output_index)
                        });
                        return;
                    }

                    if (eventType === 'response.output_item.done' && messageJson.item?.type === 'function_call') {
                        completedFunctionCalls.push(messageJson.item);
                        sendEvent(eventType, {
                            ...messageJson,
                            output_index: mapOutputIndex(messageJson.output_index)
                        });
                        return;
                    }

                    // --- Completion events ---
                    if (eventType === 'response.completed' || eventType === 'response.done') {
                        const finalResponse = messageJson.response || messageJson;

                        // Extract any function calls from the completed response that
                        // we haven't already tracked via streaming events
                        if (Array.isArray(finalResponse.output)) {
                            for (const item of finalResponse.output) {
                                if (item?.type === 'function_call' && item.status === 'completed') {
                                    const alreadyTracked = completedFunctionCalls.some(
                                        fc => (fc.call_id && fc.call_id === item.call_id) || (fc.id && fc.id === item.id)
                                    );
                                    if (!alreadyTracked) {
                                        completedFunctionCalls.push(item);
                                    }
                                }
                            }
                        }

                        const finalText = normalizeResponseOutputText(finalResponse);
                        if (finalText && !contentBuffer) {
                            contentBuffer += finalText;
                            sendTextDelta(finalText);
                        }
                        const usage = normalizeUsage(finalResponse?.usage || messageJson.usage);
                        finish(usage);
                        return;
                    }

                    if (eventType === 'response.failed' || eventType === 'response.cancelled') {
                        const errorMsg = messageJson.error?.message || messageJson.response?.error?.message || 'Stream error';
                        if (errorMsg && !contentBuffer) {
                            sendTextDelta(errorMsg);
                            contentBuffer += errorMsg;
                        }
                        const usage = normalizeUsage(messageJson.response?.usage || messageJson.usage);
                        finish(usage);
                        return;
                    }

                    // Skip other response.* events (e.g., response.output_item.added
                    // for reasoning, response.output_text.done, response.content_part.*
                    // which we emit ourselves)
                    if (progress === 1) {
                        const usage = normalizeUsage(messageJson.response?.usage || messageJson.usage);
                        finish(usage);
                    }
                    return;
                }

                // Compatibility with Anthropic-like content deltas.
                if (eventType === 'content_block_delta') {
                    const deltaText = messageJson.delta?.text;
                    if (deltaText) {
                        ensureResponseCreated();
                        contentBuffer += deltaText;
                        sendTextDelta(deltaText);
                    }
                    if (progress === 1) {
                        const usage = normalizeUsage(messageJson.usage);
                        finish(usage);
                    }
                    return;
                }
            }

            // Handle OpenAI chat completion streaming format
            if (messageJson.choices && messageJson.choices[0]) {
                const { delta, finish_reason: finishReason } = messageJson.choices[0];
                ensureResponseCreated();

                // Handle tool calls in streaming events
                if (delta?.tool_calls) {
                    delta.tool_calls.forEach((toolCall) => {
                        const idx = toolCall.index ?? 0;
                        if (!chatToolCalls.has(idx)) {
                            const callId = toolCall.id || `call_${uuidv4()}`;
                            const name = toolCall.function?.name || '';
                            chatToolCalls.set(idx, { id: callId, name, arguments: '' });
                            const localIndex = nextOutputIndex++;
                            chatToolCallIndexMap.set(idx, localIndex);
                            sendEvent('response.output_item.added', {
                                type: 'response.output_item.added',
                                output_index: localIndex,
                                item: {
                                    type: 'function_call',
                                    call_id: callId,
                                    name,
                                    arguments: '',
                                    status: 'in_progress'
                                }
                            });
                        }
                        const tc = chatToolCalls.get(idx);
                        if (toolCall.function?.name && !tc.name) {
                            tc.name = toolCall.function.name;
                        }
                        if (toolCall.function?.arguments) {
                            tc.arguments += toolCall.function.arguments;
                            const localIndex = chatToolCallIndexMap.get(idx);
                            sendEvent('response.function_call_arguments.delta', {
                                type: 'response.function_call_arguments.delta',
                                output_index: localIndex,
                                delta: toolCall.function.arguments
                            });
                        }
                    });
                }

                if (delta?.content !== undefined && delta.content !== null) {
                    contentBuffer += delta.content;
                    sendTextDelta(delta.content);
                }

                // Finalize accumulated chat tool calls on tool_calls finish reason
                if (finishReason === 'tool_calls' || (finishReason && chatToolCalls.size > 0)) {
                    for (const [idx, tc] of chatToolCalls) {
                        const localIndex = chatToolCallIndexMap.get(idx);
                        sendEvent('response.function_call_arguments.done', {
                            type: 'response.function_call_arguments.done',
                            output_index: localIndex,
                            arguments: tc.arguments
                        });
                        const item = {
                            type: 'function_call',
                            call_id: tc.id,
                            name: tc.name,
                            arguments: tc.arguments,
                            status: 'completed'
                        };
                        sendEvent('response.output_item.done', {
                            type: 'response.output_item.done',
                            output_index: localIndex,
                            item
                        });
                        completedFunctionCalls.push(item);
                    }
                    chatToolCalls.clear();
                    const usage = normalizeUsage(messageJson.usage);
                    finish(usage);
                    return;
                }

                if (finishReason || progress === 1) {
                    const usage = normalizeUsage(messageJson.usage);
                    finish(usage);
                }
                return;
            }

            // Handle direct content
            if (messageJson.content) {
                ensureResponseCreated();
                const content = messageJson.content?.[0]?.text || messageJson.content;
                contentBuffer += content;
                sendTextDelta(content);
                if (progress === 1) {
                    const usage = normalizeUsage(messageJson.usage);
                    finish(usage);
                }
                return;
            }

            if (typeof messageJson === "string" || typeof messageJson === "number" || typeof messageJson === "boolean") {
                processString(String(messageJson));
                return;
            }

            // Ignore unknown object payloads to avoid emitting "[object Object]" text.
            if (progress === 1) {
                const usage = normalizeUsage(messageJson.usage || messageJson.response?.usage);
                finish(usage);
            }
        } catch (error) {
            if (typeof progressData === "string") {
                processString(progressData);
            } else {
                // Avoid coercing object payloads to "[object Object]" on parse errors.
                if (progress === 1) {
                    finish();
                }
            }
        }
    });

    logger.info(`Rest Endpoint starting async Responses API stream, requestId: ${requestId}`);
    fireStreamResolver(requestId);

    return subscription;
};

function registerOpenAIResponsesRoute(app, pathways, openAIChatModels, openAICompletionModels, server) {
    // OpenAI Responses API endpoint (agentic API format)
    app.post('/v1/responses', async (req, res) => {
        const modelName = req.body.model || 'gpt-5.2-codex';
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

        // Check for native Responses API passthrough - format parity means zero conversion!
        if (pathwayModelName && isResponsesModel(pathwayModelName)) {
            logger.debug(`Using native Responses API passthrough for ${pathwayModelName}`);
            await handleResponsesPassthrough(req, res, pathwayModelName);
            return;
        }

        // Fall back to conversion path for non-Responses API models
        // Convert Responses API format to internal format
        // Responses API uses 'input' instead of 'messages'
        const hasInput = Object.prototype.hasOwnProperty.call(req.body, 'input');
        const rawResponsesInput = hasInput ? req.body.input : req.body.messages;
        const requestBody = {
            ...req.body,
            // If input is provided, convert to messages format for internal processing
            messages: hasInput
                ? convertResponsesInputToMessages(req.body.input)
                : normalizeResponsesMessages(req.body.messages),
            responses_input_json: serializeResponsesInput(rawResponsesInput),
            model: modelName
        };

        // Handle instructions as system message
        if (req.body.instructions && !requestBody.messages?.some(m => m.role === 'system')) {
            requestBody.messages = [
                { role: 'system', content: req.body.instructions },
                ...(requestBody.messages || [])
            ];
        }

        // Build Responses API format response
        const responseId = generateResponseId('resp');

        // Handle streaming for Responses API - must be done before processRestRequest completes
        if (Boolean(req.body.stream)) {
            const streamResponse = await processRestRequest(server, { body: requestBody }, pathway, pathwayName);
            const { resultText: requestId } = extractResponseData(streamResponse);
            processIncomingResponsesStream(requestId, req, res, pathway, modelName, responseId);
            return;
        }

        const pathwayResponse = await processRestRequest(server, { body: requestBody }, pathway, pathwayName);
        const { resultText, resultData } = extractResponseData(pathwayResponse);
        const { messageContent, toolCalls, functionCall, usage } = parseToolCalls(resultData, resultText);

        // Build output array
        const output = [];

        // Add message output
        if (messageContent || toolCalls) {
            const messageOutput = {
                type: 'message',
                id: `msg_${uuidv4()}`,
                status: 'completed',
                role: 'assistant',
                content: []
            };

            if (messageContent) {
                messageOutput.content.push({
                    type: 'output_text',
                    text: messageContent,
                    annotations: []
                });
            }

            output.push(messageOutput);
        }

        // Add function call outputs
        if (toolCalls && Array.isArray(toolCalls)) {
            toolCalls.forEach(toolCall => {
                output.push({
                    type: 'function_call',
                    id: toolCall.id,
                    call_id: toolCall.id,
                    name: toolCall.function?.name,
                    arguments: toolCall.function?.arguments,
                    status: 'completed'
                });
            });
        }

        const responsesApiResponse = {
            id: responseId,
            object: 'response',
            created_at: Math.floor(Date.now() / 1000),
            status: 'completed',
            model: modelName,
            output: output,
            output_text: messageContent || '',
            usage: ensureResponseUsage(usage)
        };

        logTokenUsage({
            req,
            usage,
            model: modelName,
            route: req.path,
            requestId: responseId
        });

        res.json(responsesApiResponse);
    });
}

export { registerOpenAIResponsesRoute, processIncomingResponsesStream };
