import logger from './logger.js';

const safeUrlParts = url => {
    try {
        const parsed = new URL(url);
        return {
            host: parsed.host,
            path: parsed.pathname,
        };
    } catch {
        return {
            host: null,
            path: null,
        };
    }
};

const safeUrlForLog = url => {
    try {
        const parsed = new URL(url);
        parsed.searchParams.forEach((value, name) => {
            if (/token|key|password|secret|auth|apikey|access|passwd|credential/i.test(name)) {
                parsed.searchParams.set(name, '******');
            }
        });
        return parsed.toString();
    } catch {
        return url;
    }
};

const detectApiFamily = (url, data = {}) => {
    if (url?.includes('/responses')) return 'openai_responses';
    if (url?.includes('/chat/completions')) return 'openai_chat_completions';
    if (url?.includes(':streamGenerateContent') || url?.includes(':generateContent')) return 'gemini';
    if (url?.includes(':streamRawPredict') || url?.includes('/anthropic/')) return 'claude_vertex';
    if (Array.isArray(data?.contents)) return 'gemini';
    if (Array.isArray(data?.messages)) return 'chat_messages';
    return 'unknown';
};

const toolName = tool => (
    tool?.name
    || tool?.function?.name
    || tool?.type
    || 'unknown'
);

export const buildModelRequestPayloadSummary = data => {
    if (!data || typeof data !== 'object') {
        return {
            payloadKind: typeof data,
        };
    }

    const tools = Array.isArray(data.tools) ? data.tools : [];
    return {
        payloadKeys: Object.keys(data).sort(),
        stream: Boolean(data.stream),
        inputCount: Array.isArray(data.input) ? data.input.length : undefined,
        messageCount: Array.isArray(data.messages) ? data.messages.length : undefined,
        contentCount: Array.isArray(data.contents) ? data.contents.length : undefined,
        toolCount: tools.length || undefined,
        toolNames: tools.length ? tools.map(toolName) : undefined,
    };
};

export const buildModelRequestLogBase = ({ url, data, traceFields = {}, axiosConfigObj = {} }) => {
    const { host, path } = safeUrlParts(url);
    return {
        requestId: traceFields.requestId,
        pathway: traceFields.pathway,
        model: traceFields.model,
        modelType: traceFields.modelType,
        metricSource: traceFields.metricSource || 'live',
        endpoint: traceFields.endpoint,
        endpointHost: host,
        endpointPath: path,
        apiFamily: detectApiFamily(url, data),
        method: axiosConfigObj?.method || 'POST',
        stream: axiosConfigObj?.responseType === 'stream' || Boolean(data?.stream),
        retry: traceFields.retry,
        duplicateIndex: traceFields.duplicateIndex,
        ...buildModelRequestPayloadSummary(data),
    };
};

export const buildModelRequestPayloadLog = ({ method = 'POST', url, data }) => {
    const { host, path } = safeUrlParts(url);
    return {
        event: 'model_request_payload',
        method,
        url: safeUrlForLog(url),
        endpointHost: host,
        endpointPath: path,
        data,
    };
};

export const buildProviderStreamEventLog = ({ requestId, resolverRequestId, pathway, model, event }) => ({
    event: 'provider_stream_event',
    requestId,
    resolverRequestId,
    pathway,
    model,
    parserEventType: event?.type ?? null,
    streamEventId: event?.id || null,
    streamEventName: event?.name || null,
    data: event?.data ?? null,
});

export const buildModelRequestErrorSummary = ({ error, responseData, status }) => ({
    status,
    errorCode: responseData?.error?.code ?? error?.code ?? null,
    errorType: responseData?.error?.type ?? error?.name ?? null,
    errorParam: responseData?.error?.param ?? null,
    message: responseData?.message
        ?? responseData?.error?.message
        ?? responseData?.error?.status
        ?? responseData?.rawContent?.substring(0, 500)
        ?? error?.message
        ?? String(error),
});

export const logModelRequestEvent = (event, fields) => {
    logger.info(JSON.stringify({
        event,
        ...fields,
    }));
};

export const logModelDebugEvent = fields => {
    logger.debug(JSON.stringify(fields));
};
