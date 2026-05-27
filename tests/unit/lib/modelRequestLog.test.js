import test from 'ava';
import {
    buildModelRequestPayloadLog,
    buildProviderStreamEventLog,
    buildModelRequestErrorSummary,
    buildModelRequestLogBase,
    buildModelRequestPayloadSummary,
} from '../../../lib/modelRequestLog.js';

test('buildModelRequestLogBase summarizes OpenAI Responses requests without prompt payloads', t => {
    const summary = buildModelRequestLogBase({
        url: 'https://example.openai.azure.com/openai/v1/responses',
        data: {
            model: 'gpt-5.4',
            stream: true,
            input: [{ role: 'user', content: 'secret prompt body' }],
            tools: [
                { type: 'function', name: 'WorkspaceSSH', description: 'long schema text' },
                { type: 'function', function: { name: 'SearchInternet' } },
            ],
        },
        traceFields: {
            requestId: 'req_123',
            pathway: 'sys_entity_agent',
            model: 'oai-gpt54',
            modelType: 'OPENAI-RESPONSES',
            endpoint: 'EUS2',
            retry: 0,
            duplicateIndex: 0,
        },
        axiosConfigObj: {
            responseType: 'stream',
        },
    });

    t.like(summary, {
        requestId: 'req_123',
        pathway: 'sys_entity_agent',
        model: 'oai-gpt54',
        modelType: 'OPENAI-RESPONSES',
        endpointHost: 'example.openai.azure.com',
        endpointPath: '/openai/v1/responses',
        apiFamily: 'openai_responses',
        stream: true,
        inputCount: 1,
        toolCount: 2,
    });
    t.deepEqual(summary.toolNames, ['WorkspaceSSH', 'SearchInternet']);
    t.false(JSON.stringify(summary).includes('secret prompt body'));
    t.false(JSON.stringify(summary).includes('long schema text'));
});

test('buildModelRequestPayloadSummary captures shape for chat payloads', t => {
    const summary = buildModelRequestPayloadSummary({
        model: 'gpt-5.4',
        messages: [{ role: 'user', content: 'hello' }],
    });

    t.deepEqual(summary.payloadKeys, ['messages', 'model']);
    t.is(summary.messageCount, 1);
    t.is(summary.stream, false);
});

test('buildModelRequestErrorSummary extracts provider error fields', t => {
    const summary = buildModelRequestErrorSummary({
        status: 400,
        error: new Error('fallback message'),
        responseData: {
            error: {
                message: "Unknown parameter: 'stream_options.include_usage'.",
                type: 'invalid_request_error',
                param: 'stream_options.include_usage',
                code: 'unknown_parameter',
            },
        },
    });

    t.like(summary, {
        status: 400,
        errorCode: 'unknown_parameter',
        errorType: 'invalid_request_error',
        errorParam: 'stream_options.include_usage',
        message: "Unknown parameter: 'stream_options.include_usage'.",
    });
});

test('buildModelRequestPayloadLog formats full debug payloads as structured events', t => {
    const log = buildModelRequestPayloadLog({
        method: 'POST',
        url: 'https://example.openai.azure.com/openai/v1/responses?api-key=secret&api-version=2025-03-01-preview',
        data: {
            input: [{ role: 'user', content: 'full prompt body' }],
        },
    });

    t.like(log, {
        event: 'model_request_payload',
        method: 'POST',
        endpointHost: 'example.openai.azure.com',
        endpointPath: '/openai/v1/responses',
    });
    t.is(log.data.input[0].content, 'full prompt body');
    t.true(log.url.includes('api-key=******'));
    t.true(log.url.includes('api-version=2025-03-01-preview'));
});

test('buildProviderStreamEventLog formats raw stream events as structured events', t => {
    const log = buildProviderStreamEventLog({
        requestId: 'root_req',
        resolverRequestId: 'resolver_req',
        pathway: 'sys_entity_agent',
        model: 'oai-gpt55',
        event: {
            type: 'event',
            id: 'evt_123',
            name: 'response.completed',
            data: '{"usage":{"input_tokens":10}}',
        },
    });

    t.deepEqual(log, {
        event: 'provider_stream_event',
        requestId: 'root_req',
        resolverRequestId: 'resolver_req',
        pathway: 'sys_entity_agent',
        model: 'oai-gpt55',
        parserEventType: 'event',
        streamEventId: 'evt_123',
        streamEventName: 'response.completed',
        data: '{"usage":{"input_tokens":10}}',
    });
});
