// rest/anthropicMessagesRoute.js
// POST /v1/messages endpoint + Anthropic conversions + Anthropic SSE streaming

import pubsub from '../pubsub.js';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../lib/logger.js';
import { processRestRequest } from './processRestRequest.js';
import {
    startSSEStream,
    safeUnsubscribe,
    fireStreamResolver,
    resolveModelName,
    extractResponseData,
    normalizeUsage,
    parseToolCalls,
    setupPassthroughStreaming,
    logTokenUsage,
} from './restUtils.js';
import { modelEndpoints, selectEndpoint, axios, buildLimiterScheduleOptions } from '../../lib/requestExecutor.js';
import { config } from '../../config.js';
import { createParser } from 'eventsource-parser';

// Claude model types that support native passthrough
const CLAUDE_MODEL_TYPES = ['CLAUDE-3-VERTEX', 'CLAUDE-4-VERTEX', 'CLAUDE-ANTHROPIC'];

// Helper to check if a model is Vertex (vs direct Anthropic API)
const isVertexModel = (model) => model?.type === 'CLAUDE-3-VERTEX' || model?.type === 'CLAUDE-4-VERTEX';

// Server-side tools that should be passed through unchanged to Claude
const SERVER_SIDE_TOOL_TYPES = ['web_search_20250305'];

const isServerSideTool = (tool) => SERVER_SIDE_TOOL_TYPES.includes(tool?.type);

const convertAnthropicToolsToOpenAI = (tools = []) => {
    if (!Array.isArray(tools)) return undefined;
    // Filter out server-side tools - they only work with Claude passthrough
    const functionTools = tools.filter(tool => !isServerSideTool(tool));
    if (functionTools.length === 0) return undefined;
    return functionTools.map((tool) => ({
        type: "function",
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema || { type: "object", properties: {} }
        }
    }));
};

const mapStopReason = (finishReason) => {
    if (finishReason === "tool_calls" || finishReason === "function_call") return "tool_use";
    if (finishReason === "length" || finishReason === "max_tokens") return "max_tokens";
    if (finishReason === "stop_sequence") return "stop_sequence";
    return "end_turn";
};

const convertAnthropicToolChoiceToOpenAI = (toolChoice) => {
    if (!toolChoice) return undefined;
    if (typeof toolChoice === "string") return toolChoice;
    if (toolChoice.type === "auto" || toolChoice.type === "any") return "auto";
    if (toolChoice.type === "tool" && toolChoice.name) {
        return { type: "function", function: { name: toolChoice.name } };
    }
    return undefined;
};

const normalizeAnthropicTextBlocks = (content) => {
    if (content == null) return "";
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return JSON.stringify(content);
    return content
        .map((block) => {
            if (typeof block === "string") return block;
            if (block?.type === "text") return block.text || "";
            return JSON.stringify(block);
        })
        .join("\n")
        .trim();
};

const convertAnthropicMessagesToOpenAI = (messages = [], system) => {
    const openAiMessages = [];

    if (system) {
        const systemText = normalizeAnthropicTextBlocks(system);
        if (systemText) {
            openAiMessages.push({ role: "system", content: systemText });
        }
    }

    for (const message of messages) {
        if (!message || !message.role) continue;
        const role = message.role;
        const content = message.content ?? "";

        const textParts = [];
        const imageParts = [];
        const toolUses = [];
        const toolResults = [];

        if (typeof content === "string") {
            textParts.push(content);
        } else if (Array.isArray(content)) {
            for (const block of content) {
                if (typeof block === "string") {
                    textParts.push(block);
                    continue;
                }
                if (block?.type === "text") {
                    textParts.push(block.text || "");
                    continue;
                }
                if (block?.type === "image") {
                    const source = block.source || {};
                    if (source.type === "base64" && source.media_type && source.data) {
                        imageParts.push({
                            type: "image_url",
                            image_url: { url: `data:${source.media_type};base64,${source.data}` }
                        });
                    } else if (source.type === "url" && source.url) {
                        imageParts.push({
                            type: "image_url",
                            image_url: { url: source.url }
                        });
                    }
                    continue;
                }
                if (block?.type === "tool_use") {
                    toolUses.push(block);
                    continue;
                }
                if (block?.type === "tool_result") {
                    toolResults.push(block);
                    continue;
                }
                // Note: server_tool_use and web_search_tool_result blocks are ignored here -
                // Claude clients use native passthrough which handles these directly
                if (block?.type === "server_tool_use" || block?.type === "web_search_tool_result") {
                    continue;
                }
                textParts.push(JSON.stringify(block));
            }
        } else {
            textParts.push(JSON.stringify(content));
        }

        if (toolUses.length > 0) {
            openAiMessages.push({
                role: "assistant",
                content: textParts.join("\n").trim() || "",
                tool_calls: toolUses.map((toolUse, index) => ({
                    id: toolUse.id || `call_${index}_${Date.now()}`,
                    type: "function",
                    function: {
                        name: toolUse.name || "",
                        arguments: JSON.stringify(toolUse.input ?? {})
                    }
                }))
            });
        } else if (imageParts.length > 0) {
            const contentParts = [];
            const text = textParts.join("\n").trim();
            if (text) contentParts.push({ type: "text", text });
            contentParts.push(...imageParts);
            openAiMessages.push({ role, content: contentParts });
        } else if (textParts.length > 0) {
            openAiMessages.push({
                role,
                content: textParts.join("\n").trim()
            });
        }

        if (toolResults.length > 0) {
            toolResults.forEach((toolResult) => {
                openAiMessages.push({
                    role: "tool",
                    tool_call_id: toolResult.tool_use_id || `call_${Date.now()}`,
                    content: normalizeAnthropicTextBlocks(toolResult.content)
                });
            });
        }
    }

    return openAiMessages;
};

const convertAnthropicRequestToOpenAI = (body = {}) => {
    const messages = convertAnthropicMessagesToOpenAI(body.messages || [], body.system);
    const tools = convertAnthropicToolsToOpenAI(body.tools);
    const tool_choice = convertAnthropicToolChoiceToOpenAI(body.tool_choice);

    return {
        messages,
        tools,
        tool_choice,
        max_tokens: body.max_tokens ?? body.max_tokens_to_sample,
        temperature: body.temperature,
        top_p: body.top_p,
        stop: body.stop_sequences || body.stop,
        stream: body.stream
    };
};

const parseToolCallInput = (args) => {
    try {
        return JSON.parse(args || "{}");
    } catch (e) {
        return {};
    }
};

const convertOpenAIResultToAnthropicMessage = ({ messageContent, toolCalls, finishReason, model, usage }) => {
    const content = [];
    if (messageContent) {
        content.push({ type: "text", text: messageContent });
    }

    if (toolCalls && Array.isArray(toolCalls)) {
        toolCalls.forEach((toolCall, index) => {
            content.push({
                type: "tool_use",
                id: toolCall.id || `call_${index}_${Date.now()}`,
                name: toolCall.function?.name || "",
                input: parseToolCallInput(toolCall.function?.arguments)
            });
        });
    }

    return {
        id: `msg_${uuidv4()}`,
        type: "message",
        role: "assistant",
        model,
        content,
        stop_reason: mapStopReason(finishReason),
        stop_sequence: null,
        usage: usage || { input_tokens: 0, output_tokens: 0 }
    };
};

const processIncomingAnthropicStream = (requestId, req, res, pathway, modelName) => {
    const messageId = `msg_${uuidv4()}`;
    let started = false;
    let textBlockIndex = null;
    let nextBlockIndex = 0;
    const toolCallBlockIndex = new Map();

    const sendEvent = (event, data) => {
        if (res.writableEnded) return;
        logger.debug(`Anthropic SSE sending event=${event}: ${JSON.stringify(data)}`);
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let initialUsage = null;

    const sendMessageStart = () => {
        if (started) return;
        started = true;
        sendEvent("message_start", {
            type: "message_start",
            message: {
                id: messageId,
                type: "message",
                role: "assistant",
                model: modelName,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: initialUsage || { input_tokens: 0, output_tokens: 0 }
            }
        });
    };

    const ensureTextBlock = () => {
        if (textBlockIndex !== null) return textBlockIndex;
        textBlockIndex = nextBlockIndex++;
        sendEvent("content_block_start", {
            type: "content_block_start",
            index: textBlockIndex,
            content_block: { type: "text", text: "" }
        });
        return textBlockIndex;
    };

    const ensureToolBlock = (toolCall) => {
        const callIndex = toolCall.index ?? 0;
        if (toolCallBlockIndex.has(callIndex)) return toolCallBlockIndex.get(callIndex);
        const nextIndex = nextBlockIndex++;
        toolCallBlockIndex.set(callIndex, nextIndex);
        sendEvent("content_block_start", {
            type: "content_block_start",
            index: nextIndex,
            content_block: {
                type: "tool_use",
                id: toolCall.id || `call_${callIndex}_${Date.now()}`,
                name: toolCall.function?.name || "",
                input: {}
            }
        });
        return nextIndex;
    };

    const sendTextDelta = (text) => {
        if (text == null) return;
        const textValue = typeof text === 'string' ? text : String(text);
        if (!textValue) return;
        const index = ensureTextBlock();
        sendEvent("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: textValue }
        });
    };

    const sendToolDelta = (toolCall) => {
        const index = ensureToolBlock(toolCall);
        const partial = toolCall.function?.arguments || "";
        if (!partial) return;
        sendEvent("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: partial }
        });
    };

    const stopBlocks = () => {
        if (textBlockIndex !== null) {
            sendEvent("content_block_stop", { type: "content_block_stop", index: textBlockIndex });
        }
        for (const index of toolCallBlockIndex.values()) {
            sendEvent("content_block_stop", { type: "content_block_stop", index });
        }
    };

    const stopMessage = (stopReason, usage = null) => {
        const anthropicDeltaUsage = {};
        if (usage) {
            if (usage.output_tokens != null) anthropicDeltaUsage.output_tokens = usage.output_tokens;
            if (usage.input_tokens != null) anthropicDeltaUsage.input_tokens = usage.input_tokens;
            if (usage.cache_creation_input_tokens != null) anthropicDeltaUsage.cache_creation_input_tokens = usage.cache_creation_input_tokens;
            if (usage.cache_read_input_tokens != null) anthropicDeltaUsage.cache_read_input_tokens = usage.cache_read_input_tokens;
            // Pass through server_tool_use usage (e.g., web_search_requests count)
            if (usage.server_tool_use != null) anthropicDeltaUsage.server_tool_use = usage.server_tool_use;
        }
        sendEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            ...(Object.keys(anthropicDeltaUsage).length > 0 ? { usage: anthropicDeltaUsage } : {})
        });
        sendEvent("message_stop", { type: "message_stop" });
    };

    startSSEStream(res);

    if (requestId.startsWith('[ERROR]')) {
        sendMessageStart();
        sendTextDelta(requestId);
        stopBlocks();
        stopMessage("end_turn");
        res.end();
        return;
    }

    let subscription;

    subscription = pubsub.subscribe('REQUEST_PROGRESS', (data) => {
        if (data.requestProgress.requestId !== requestId) return;

        const { progress, data: progressData, error: progressError } = data.requestProgress;

        const finish = (stopReason = "end_turn", usage = null) => {
            logTokenUsage({
                req,
                usage,
                model: modelName,
                route: req?.path,
                requestId
            });
            stopBlocks();
            stopMessage(stopReason, usage);
            safeUnsubscribe(subscription);
            res.end();
        };

        const processString = (text) => {
            sendMessageStart();
            sendTextDelta(text);
            if (progress === 1) {
                finish("end_turn");
            }
        };

        try {
            if (progressError && !progressData) {
                sendMessageStart();
                sendTextDelta(progressError);
                finish("end_turn");
                return;
            }

            const messageJson = JSON.parse(progressData);
            if (typeof messageJson === "string") {
                processString(messageJson);
                return;
            }

            if (messageJson?.error) {
                sendMessageStart();
                sendTextDelta(messageJson.error?.message || "Stream error");
                finish("end_turn");
                return;
            }

            if (typeof messageJson.type === 'string' && messageJson.type.startsWith('response.')) {
                const eventType = messageJson.type;
                sendMessageStart();

                if (eventType === 'response.output_text.delta') {
                    const deltaText = typeof messageJson.delta === 'string' ? messageJson.delta : '';
                    sendTextDelta(deltaText);
                    return;
                }

                if (eventType === 'response.completed' || eventType === 'response.done') {
                    const usage = normalizeUsage(messageJson.response?.usage || messageJson.usage);
                    finish("end_turn", usage);
                    return;
                }

                if (eventType === 'response.failed' || eventType === 'response.cancelled') {
                    const errorMsg = messageJson.error?.message || messageJson.response?.error?.message || 'Stream error';
                    sendTextDelta(errorMsg);
                    const usage = normalizeUsage(messageJson.response?.usage || messageJson.usage);
                    finish("end_turn", usage);
                    return;
                }

                if (progress === 1) {
                    const usage = normalizeUsage(messageJson.response?.usage || messageJson.usage);
                    finish("end_turn", usage);
                }
                return;
            }

            if (messageJson.choices && messageJson.choices[0]) {
                const { delta, finish_reason: finishReason } = messageJson.choices[0];
                // Capture initial usage (e.g. input_tokens from message_start) before first sendMessageStart
                if (!started && messageJson.usage) {
                    initialUsage = normalizeUsage(messageJson.usage);
                }
                sendMessageStart();

                if (delta?.tool_calls) {
                    delta.tool_calls.forEach((toolCall) => {
                        ensureToolBlock(toolCall);
                        if (toolCall.function?.arguments) {
                            sendToolDelta(toolCall);
                        }
                    });
                }

                if (delta?.content !== undefined && delta.content !== null) {
                    sendTextDelta(delta.content);
                }

                if (finishReason) {
                    const usage = normalizeUsage(messageJson.usage);
                    logger.debug(`Anthropic stream finish with usage: ${JSON.stringify(usage)}`);
                    finish(mapStopReason(finishReason), usage);
                } else if (progress === 1) {
                    const usage = normalizeUsage(messageJson.usage);
                    logger.debug(`Anthropic stream progress=1 with usage: ${JSON.stringify(usage)}`);
                    finish("end_turn", usage);
                }
                return;
            }

            if (messageJson.tool_calls) {
                sendMessageStart();
                messageJson.tool_calls.forEach((toolCall) => ensureToolBlock(toolCall));
                const usage = normalizeUsage(messageJson.usage);
                finish("tool_use", usage);
                return;
            }

            if (messageJson.content) {
                sendMessageStart();
                const content = messageJson.content?.[0]?.text || messageJson.content;
                sendTextDelta(content);
                if (progress === 1) {
                    const usage = normalizeUsage(messageJson.usage);
                    finish("end_turn", usage);
                }
                return;
            }

            if (progress === 1) {
                const usage = normalizeUsage(messageJson.usage || messageJson.response?.usage);
                finish("end_turn", usage);
            }
        } catch (error) {
            if (typeof progressData === "string") {
                processString(progressData);
            } else {
                if (progressError) {
                    sendMessageStart();
                    sendTextDelta(progressError);
                }
                if (progress === 1) {
                    finish("end_turn");
                }
            }
        }
    });

    logger.info(`Rest Endpoint starting async requestProgress, requestId: ${requestId}`);
    fireStreamResolver(requestId);

    return subscription;
};

/**
 * Check if a model supports native Anthropic passthrough (no conversion needed)
 */
const isClaudeModel = (pathwayModelName) => {
    const model = modelEndpoints[pathwayModelName];
    return model && CLAUDE_MODEL_TYPES.includes(model.type);
};

/**
 * Get the model name to send to the Claude API
 * For Vertex, it's in the URL. For direct Anthropic API, it needs to be in the body.
 */
const getClaudeModelName = (model, endpoint) => {
    // For direct Anthropic API, model name comes from endpoint params
    if (model.type === 'CLAUDE-ANTHROPIC') {
        return endpoint?.params?.model || model.params?.model || model.name;
    }
    // For Vertex, model is in URL, not needed in body
    return null;
};

/**
 * Native passthrough for Claude models - streams SSE directly without conversion
 */
const handleClaudePassthrough = async (req, res, pathwayModelName) => {
    const requestId = uuidv4();
    const model = modelEndpoints[pathwayModelName];
    const endpoint = selectEndpoint(model);

    if (!endpoint) {
        res.status(500).json({
            type: "error",
            error: { type: "server_error", message: "No endpoint available for model" }
        });
        return;
    }

    const isStreaming = Boolean(req.body.stream);

    // Build the request - minimal transformation, just pass through
    const requestBody = { ...req.body };
    const isVertex = isVertexModel(model);

    // Build URL and configure request based on model type
    let url = endpoint.url;
    const headers = {
        'Content-Type': 'application/json',
        ...endpoint.headers
    };

    if (isVertex) {
        // Vertex AI: anthropic_version in body, model in URL, GCP auth
        requestBody.anthropic_version = 'vertex-2023-10-16';
        delete requestBody.model;

        // Vertex AI doesn't support all cache_control properties that direct Anthropic API does
        // Strip unsupported fields to avoid "Extra inputs are not permitted" errors
        if (requestBody.system && Array.isArray(requestBody.system)) {
            requestBody.system = requestBody.system.map(block => {
                if (block.cache_control) {
                    // Vertex only supports { type: "ephemeral" }, not additional fields like "scope"
                    return { ...block, cache_control: { type: block.cache_control.type || "ephemeral" } };
                }
                return block;
            });
        }

        // Vertex AI doesn't support these Anthropic-specific parameters
        delete requestBody.context_management;
        delete requestBody.output_config;

        url += isStreaming ? ':streamRawPredict?alt=sse' : ':rawPredict';

        const gcpAuthTokenHelper = config.get('gcpAuthTokenHelper');
        if (gcpAuthTokenHelper) {
            const authToken = await gcpAuthTokenHelper.getAccessToken();
            headers['Authorization'] = `Bearer ${authToken}`;
        }
    } else {
        // Direct Anthropic API: model in body, anthropic-version header
        const modelName = getClaudeModelName(model, endpoint);
        if (modelName) {
            requestBody.model = modelName;
        }
        headers['anthropic-version'] = '2023-06-01';
    }

    logger.info(`[${requestId}] Claude passthrough: ${model.type} ${isStreaming ? 'streaming' : 'non-streaming'}`);

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
                model: response.data?.model || requestBody.model || model.name,
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
        // Track usage from message_delta events (Claude sends output_tokens there)
        let accumulatedUsage = null;
        let usageLogged = false;
        const onParse = (event) => {
            if (event.type === 'event') {
                if (!usageLogged && event.data) {
                    try {
                        const parsed = JSON.parse(event.data);
                        const eventType = parsed?.type;

                        // Claude sends usage in message_delta (output_tokens) and message_start (input_tokens)
                        if (eventType === 'message_start' && parsed.message?.usage) {
                            // message_start contains input_tokens
                            accumulatedUsage = { ...parsed.message.usage };
                        } else if (eventType === 'message_delta' && parsed.usage) {
                            // message_delta contains output_tokens when stop_reason is present
                            accumulatedUsage = { ...accumulatedUsage, ...parsed.usage };
                        }

                        // Log on terminal events
                        if (
                            eventType === 'message_stop' ||
                            eventType === 'response.completed' ||
                            eventType === 'response.done' ||
                            eventType === 'response.failed' ||
                            eventType === 'response.cancelled'
                        ) {
                            // Use accumulated usage from prior events, or fall back to inline usage
                            const usage = accumulatedUsage || parsed.message?.usage || parsed.response?.usage || parsed.usage;
                            logTokenUsage({
                                req,
                                usage,
                                model: parsed.message?.model || parsed.response?.model || requestBody.model || model.name,
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
            logPrefix: 'Claude passthrough'
        });

    } catch (error) {
        const status = error.response?.status || 500;
        // Safely extract error data - avoid circular references from axios response objects
        let errorData;
        if (error.response?.data && typeof error.response.data === 'object') {
            // Only extract safe, serializable fields
            errorData = {
                type: error.response.data.type || 'error',
                message: error.response.data.error?.message || error.response.data.message || error.message
            };
        } else {
            errorData = { type: 'error', message: error.message };
        }

        logger.error(`[${requestId}] Claude passthrough error: ${status} ${errorData.message}`);

        if (isStreaming && !res.headersSent) {
            startSSEStream(res);
            res.write(`event: error\n`);
            res.write(`data: ${JSON.stringify({ type: "error", error: errorData })}\n\n`);
            res.end();
        } else if (!res.headersSent) {
            res.status(status).json({
                type: "error",
                error: errorData
            });
        }
    }
};

function registerAnthropicMessagesRoute(app, pathways, openAIChatModels, openAICompletionModels, server) {
    app.post('/v1/messages', async (req, res) => {
        const modelName = req.body.model || 'gpt-3.5-turbo';
        const { pathwayName, isOllama } = resolveModelName(modelName, openAIChatModels, openAICompletionModels, true);

        if (!pathwayName) {
            res.status(404).json({
                type: "error",
                error: { type: "not_found_error", message: `Model ${modelName} not found.` }
            });
            return;
        }

        // Get the underlying model name from the pathway
        const pathway = pathways[pathwayName];
        const pathwayModelName = pathway?.model;

        // Check for native Claude passthrough - format parity means zero conversion!
        if (pathwayModelName && isClaudeModel(pathwayModelName)) {
            logger.debug(`Using native Claude passthrough for ${pathwayModelName}`);
            await handleClaudePassthrough(req, res, pathwayModelName);
            return;
        }

        // Fall back to conversion path for non-Claude models
        if (isOllama) {
            req.body.ollamaModel = modelName.replace('ollama-', '');
        }

        const openAiBody = convertAnthropicRequestToOpenAI(req.body);
        const requestBody = {
            ...req.body,
            ...openAiBody,
            model: modelName,
        };

        const pathwayResponse = await processRestRequest(server, { body: requestBody }, pathway, pathwayName);
        const { resultText, resultData } = extractResponseData(pathwayResponse);
        const { messageContent, toolCalls, finishReason, usage } = parseToolCalls(resultData, resultText);

        if (req.body.stream) {
            processIncomingAnthropicStream(resultText, req, res, pathway, modelName);
            return;
        }

        const anthropicResponse = convertOpenAIResultToAnthropicMessage({
            messageContent,
            toolCalls,
            finishReason,
            model: modelName,
            usage
        });

        logTokenUsage({
            req,
            usage,
            model: modelName,
            route: req.path,
            requestId: anthropicResponse?.id
        });

        res.json(anthropicResponse);
    });
}

export {
    registerAnthropicMessagesRoute,
    processIncomingAnthropicStream,
    convertOpenAIResultToAnthropicMessage,
    convertAnthropicMessagesToOpenAI,
    convertAnthropicToolsToOpenAI,
    isServerSideTool,
    mapStopReason,
};
