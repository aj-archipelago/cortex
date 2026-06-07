// rest/restUtils.js
// Shared utilities used by multiple REST route handlers

import pubsub from '../pubsub.js';
import { requestState } from '../requestState.js';
import logger from '../../lib/logger.js';
import tokenUsageStore from '../../lib/TokenUsageStore.js';
import { buildTokenUsageEventKey } from '../../lib/tokenUsageEventKey.js';
import { v4 as uuidv4 } from 'uuid';

// --- Shared streaming helpers ---

const startSSEStream = (res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
};

const safeUnsubscribe = async (subscription) => {
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
};

const fireStreamResolver = (requestId) => {
    const { resolver, args } = requestState[requestId];
    requestState[requestId].useRedis = false;
    requestState[requestId].started = true;
    resolver && resolver(args);
};

// --- Model resolution ---

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

// --- Response data helpers ---

const extractResponseData = (pathwayResponse) => {
    if (typeof pathwayResponse === 'string') {
        return { resultText: pathwayResponse, resultData: null };
    }
    return {
        resultText: pathwayResponse.result || "",
        resultData: pathwayResponse.resultData || null
    };
};

const coerceTokenCount = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
};

const getCachedInputTokens = (usageObj) => coerceTokenCount(
    usageObj.cache_read_input_tokens ??
    usageObj.cacheReadInputTokens ??
    usageObj.cache_read_tokens ??
    usageObj.cachedContentTokenCount ??
    usageObj.cached_content_token_count ??
    usageObj.input_tokens_details?.cached_tokens ??
    usageObj.prompt_tokens_details?.cached_tokens
);

const getOpenAiCachedInputTokens = (usageObj) => coerceTokenCount(
    usageObj.input_tokens_details?.cached_tokens ??
    usageObj.prompt_tokens_details?.cached_tokens
);

const normalizeUsage = (usage) => {
    if (!usage) return null;

    const usageObj = Array.isArray(usage) ? usage[0] : usage;
    if (!usageObj || typeof usageObj !== 'object') return null;

    const inputTokens = coerceTokenCount(
        usageObj.input_tokens ??
        usageObj.prompt_tokens ??
        usageObj.inputTokenCount ??
        usageObj.inputTokens ??
        usageObj.promptTokenCount ??
        usageObj.prompt_token_count
    );
    const cacheReadInputTokens = getCachedInputTokens(usageObj);
    const openAiCachedInputTokens = getOpenAiCachedInputTokens(usageObj);
    const billableInputTokens = inputTokens != null && openAiCachedInputTokens != null
        ? Math.max(0, inputTokens - openAiCachedInputTokens)
        : inputTokens;
    const outputTokens = coerceTokenCount(
        usageObj.output_tokens ??
        usageObj.completion_tokens ??
        usageObj.outputTokenCount ??
        usageObj.outputTokens ??
        usageObj.candidatesTokenCount ??
        usageObj.candidates_token_count
    );
    const explicitTotal = coerceTokenCount(
        usageObj.total_tokens ?? usageObj.totalTokenCount ?? usageObj.total_token_count
    );
    const totalTokens = explicitTotal ?? (
        inputTokens != null && outputTokens != null
            ? inputTokens + outputTokens
            : null
    );

    const normalized = {
        input_tokens: billableInputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        cache_creation_input_tokens: coerceTokenCount(
            usageObj.cache_creation_input_tokens ?? usageObj.cacheCreationInputTokens ?? usageObj.cache_creation_tokens
        ),
        cache_read_input_tokens: cacheReadInputTokens
    };

    // Pass through server_tool_use if present (e.g., web_search_requests count)
    if (usageObj.server_tool_use && typeof usageObj.server_tool_use === 'object') {
        normalized.server_tool_use = usageObj.server_tool_use;
    }

    // Remove null/undefined keys
    Object.keys(normalized).forEach((key) => {
        if (normalized[key] == null) {
            delete normalized[key];
        }
    });

    return Object.keys(normalized).length > 0 ? normalized : null;
};

const logTokenUsage = ({ req, usage, model, route, requestId }) => {
    if (!req || !usage) return;
    if (req._cortexUsageLogged) return;

    const apiKeyId = req.cortexApiKeyId || 'local';

    const normalized = normalizeUsage(usage) || usage;
    if (!normalized || (
        normalized.input_tokens == null &&
        normalized.output_tokens == null &&
        normalized.total_tokens == null &&
        normalized.cache_creation_input_tokens == null &&
        normalized.cache_read_input_tokens == null
    )) {
        return;
    }

    req._cortexUsageLogged = true;

    const payload = {
        event: 'token_usage',
        api_key_id: apiKeyId,
        input_tokens: normalized.input_tokens ?? null,
        output_tokens: normalized.output_tokens ?? null,
        total_tokens: normalized.total_tokens ?? null,
        cache_creation_input_tokens: normalized.cache_creation_input_tokens ?? null,
        cache_read_input_tokens: normalized.cache_read_input_tokens ?? null,
        server_tool_use: normalized.server_tool_use ?? null,
        model: model || req.body?.model || null,
        route: route || req.path || null,
        request_id: requestId || null,
        stream: Boolean(req.body?.stream)
    };
    payload.event_key = buildTokenUsageEventKey(payload);

    try {
        logger.info(JSON.stringify(payload));
    } catch (error) {
        logger.warn(`token_usage log failed: ${error?.message || error}`);
        try {
            logger.info(JSON.stringify({
                event: 'token_usage',
                api_key_id: apiKeyId,
                error: 'serialize_failed'
            }));
        } catch {
            // Swallow logging failures to avoid impacting request handling
        }
    }

    // Persist to MongoDB for the usage portal
    tokenUsageStore.log(payload);
};

const normalizeResponseOutputText = (payload) => {
    if (!payload || typeof payload !== 'object') return '';

    const responsePayload = payload.response && typeof payload.response === 'object'
        ? payload.response
        : payload;

    if (typeof responsePayload.output_text === 'string' && responsePayload.output_text) {
        return responsePayload.output_text;
    }

    if (Array.isArray(responsePayload.output)) {
        return responsePayload.output
            .flatMap((item) => {
                if (!item || !Array.isArray(item.content)) return [];
                return item.content
                    .filter((part) => part && typeof part === 'object')
                    .map((part) => {
                        if (typeof part.text === 'string') return part.text;
                        if (typeof part.delta === 'string') return part.delta;
                        return '';
                    });
            })
            .filter((text) => text)
            .join('');
    }

    return '';
};

const isLikelyRequestId = (value) => {
    if (typeof value !== 'string') return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
};

const extractPathwayErrorMessage = (pathwayResponse) => {
    if (!pathwayResponse || typeof pathwayResponse !== 'object') return '';

    const { errors } = pathwayResponse;
    if (Array.isArray(errors) && errors.length > 0) {
        const firstError = errors[0];
        if (typeof firstError === 'string') return firstError;
        if (firstError && typeof firstError.message === 'string') return firstError.message;
    }
    if (typeof errors === 'string') {
        return errors;
    }

    return '';
};

const parseToolCalls = (resultData, resultText) => {
    let messageContent = resultText;
    let toolCalls = null;
    let functionCall = null;
    let finishReason = 'stop';
    let usage = null;

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
            if (parsedResultData && parsedResultData.usage) {
                usage = normalizeUsage(parsedResultData.usage);
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

    return { messageContent, toolCalls, functionCall, finishReason, usage };
};

const generateResponseId = (prefix) => {
    const requestId = uuidv4();
    return `${prefix}-${requestId}`;
};

/**
 * Set up passthrough streaming with proper cleanup handling.
 * Forwards SSE events from upstream to client and handles disconnection cleanup.
 *
 * @param {object} options
 * @param {object} options.req - Express request object
 * @param {object} options.res - Express response object
 * @param {object} options.incomingMessage - Axios response stream
 * @param {object} options.sseParser - eventsource-parser instance
 * @param {object} options.abortController - AbortController for the upstream request
 * @param {string} options.requestId - Request ID for logging
 * @param {string} options.logPrefix - Prefix for log messages (e.g., "Claude passthrough" or "Responses API")
 */
const setupPassthroughStreaming = ({ req, res, incomingMessage, sseParser, abortController, requestId, logPrefix }) => {
    let cleanedUp = false;
    let streamEnded = false;

    const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        if (abortController && !abortController.signal.aborted) {
            abortController.abort();
        }
        // Only destroy if stream hasn't ended naturally - destroying an ended stream
        // emits a spurious 'error' event with "canceled"
        if (incomingMessage?.destroy && !streamEnded) {
            incomingMessage.destroy();
        }
    };

    req.once('aborted', cleanup);
    res.once('close', cleanup);

    incomingMessage.on('data', (chunk) => {
        sseParser.feed(chunk.toString());
    });

    incomingMessage.on('end', () => {
        streamEnded = true;
        if (!res.writableEnded) {
            res.end();
        }
        cleanup();
    });

    incomingMessage.on('error', (err) => {
        // Ignore "canceled" errors from cleanup - these are expected when we abort the stream
        if (err.message === 'canceled' && cleanedUp) {
            return;
        }
        logger.error(`[${requestId}] ${logPrefix} stream error: ${err.message}`);
        if (!res.writableEnded) {
            res.write(`event: error\n`);
            res.write(`data: ${JSON.stringify({ type: "error", error: { message: err.message } })}\n\n`);
            res.end();
        }
        cleanup();
    });

    return cleanup;
};

export {
    startSSEStream,
    safeUnsubscribe,
    fireStreamResolver,
    resolveModelName,
    handleModelNotFound,
    extractResponseData,
    normalizeUsage,
    logTokenUsage,
    normalizeResponseOutputText,
    isLikelyRequestId,
    extractPathwayErrorMessage,
    parseToolCalls,
    generateResponseId,
    setupPassthroughStreaming,
};
