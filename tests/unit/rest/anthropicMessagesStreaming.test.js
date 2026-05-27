// anthropicMessagesStreaming.test.js
// Unit tests for Anthropic Messages API streaming + conversion fixes

import test from 'ava';
import pubsub from '../../../server/pubsub.js';
import { requestState } from '../../../server/requestState.js';
import {
    processIncomingAnthropicStream,
    convertOpenAIResultToAnthropicMessage,
    convertAnthropicMessagesToOpenAI,
    mapStopReason,
    convertAnthropicToolsToOpenAI,
    isServerSideTool,
} from '../../../server/rest/anthropicMessagesRoute.js';

// --- Helpers ---

const createMockRes = () => {
    const writes = [];
    return {
        writes,
        writableEnded: false,
        setHeader() {},
        flushHeaders() {},
        write(chunk) { writes.push(chunk); },
        end() { this.writableEnded = true; },
    };
};

const createMockReq = () => ({
    path: '/v1/messages',
    body: {}
});

const parseSSEEvents = (writes) => {
    const raw = writes.join('');
    const frames = raw.split(/\n\n/).filter(f => f.trim());
    const events = [];
    for (const frame of frames) {
        const lines = frame.split('\n');
        let eventName = null;
        const dataLines = [];
        for (const line of lines) {
            if (line.startsWith('event: ')) eventName = line.slice('event: '.length);
            else if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length));
        }
        if (dataLines.length) {
            try {
                events.push({ event: eventName, data: JSON.parse(dataLines.join('\n')) });
            } catch (_) {
                events.push({ event: eventName, data: dataLines.join('\n') });
            }
        }
    }
    return events;
};

const seedRequestState = (requestId) => {
    requestState[requestId] = {
        resolver: () => {},
        args: {},
        useRedis: false,
        started: false,
    };
};

const cleanupRequestState = (requestId) => {
    delete requestState[requestId];
};

const simulateEvent = async (requestId, progress, data) => {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    await pubsub.publish('REQUEST_PROGRESS', {
        requestProgress: { requestId, progress, data: payload },
    });
};

const tick = () => new Promise(r => setTimeout(r, 20));

// ============================================================================
// 1) Text streaming baseline
// ============================================================================

test.serial('text streaming: emits correct Anthropic SSE event sequence', async (t) => {
    const requestId = 'test-anth-text-' + Date.now();
    const req = createMockReq();
    const res = createMockRes();
    seedRequestState(requestId);

    processIncomingAnthropicStream(requestId, req, res, {}, 'claude-3-sonnet');
    await tick();

    // Send text deltas via OpenAI choices format
    await simulateEvent(requestId, 0, {
        choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
    });
    await tick();
    await simulateEvent(requestId, 0, {
        choices: [{ delta: { content: ' world' }, finish_reason: null }],
    });
    await tick();

    // Complete with finish_reason
    await simulateEvent(requestId, 1, {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    await tick();

    const events = parseSSEEvents(res.writes);
    const eventTypes = events.map(e => e.event);

    // Verify ordering: message_start -> content_block_start -> deltas -> content_block_stop -> message_delta -> message_stop
    t.true(eventTypes.includes('message_start'), 'should have message_start');
    t.true(eventTypes.includes('content_block_start'), 'should have content_block_start');
    t.true(eventTypes.includes('content_block_delta'), 'should have content_block_delta');
    t.true(eventTypes.includes('content_block_stop'), 'should have content_block_stop');
    t.true(eventTypes.includes('message_delta'), 'should have message_delta');
    t.true(eventTypes.includes('message_stop'), 'should have message_stop');

    const startIdx = eventTypes.indexOf('message_start');
    const stopIdx = eventTypes.lastIndexOf('message_stop');
    t.true(startIdx < stopIdx);

    // Verify message_start structure
    const msgStart = events.find(e => e.event === 'message_start');
    t.is(msgStart.data.message.role, 'assistant');
    t.is(msgStart.data.message.model, 'claude-3-sonnet');

    // Verify text deltas
    const deltas = events.filter(e => e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta');
    const accumulated = deltas.map(e => e.data.delta.text).join('');
    t.is(accumulated, 'Hello world');

    // Verify content_block_start is text type
    const blockStart = events.find(e => e.event === 'content_block_start');
    t.is(blockStart.data.content_block.type, 'text');

    t.true(res.writableEnded);
    cleanupRequestState(requestId);
});

// ============================================================================
// 2) Tool use streaming
// ============================================================================

test.serial('tool use streaming: emits tool_use content blocks from delta.tool_calls', async (t) => {
    const requestId = 'test-anth-tool-' + Date.now();
    const req = createMockReq();
    const res = createMockRes();
    seedRequestState(requestId);

    processIncomingAnthropicStream(requestId, req, res, {}, 'claude-3-sonnet');
    await tick();

    // Send tool call start
    await simulateEvent(requestId, 0, {
        choices: [{
            delta: {
                tool_calls: [{
                    index: 0,
                    id: 'call_abc',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '' },
                }],
            },
            finish_reason: null,
        }],
    });
    await tick();

    // Send tool call arguments
    await simulateEvent(requestId, 0, {
        choices: [{
            delta: {
                tool_calls: [{
                    index: 0,
                    function: { arguments: '{"location":"Boston"}' },
                }],
            },
            finish_reason: null,
        }],
    });
    await tick();

    // Complete with tool_calls finish_reason
    await simulateEvent(requestId, 1, {
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    await tick();

    const events = parseSSEEvents(res.writes);
    const eventTypes = events.map(e => e.event);

    // Should have tool_use content_block_start
    const blockStarts = events.filter(e => e.event === 'content_block_start');
    const toolBlockStart = blockStarts.find(e => e.data.content_block.type === 'tool_use');
    t.truthy(toolBlockStart, 'should have tool_use content_block_start');
    t.is(toolBlockStart.data.content_block.name, 'get_weather');

    // Should have input_json_delta
    const jsonDeltas = events.filter(e =>
        e.event === 'content_block_delta' && e.data.delta?.type === 'input_json_delta'
    );
    t.true(jsonDeltas.length > 0, 'should have input_json_delta');

    // message_delta should have stop_reason "tool_use"
    const msgDelta = events.find(e => e.event === 'message_delta');
    t.is(msgDelta.data.delta.stop_reason, 'tool_use');

    t.true(res.writableEnded);
    cleanupRequestState(requestId);
});

// ============================================================================
// 3) Stop reason mapping
// ============================================================================

test.serial('stop reason mapping: maps finish reasons correctly', (t) => {
    t.is(mapStopReason('tool_calls'), 'tool_use');
    t.is(mapStopReason('function_call'), 'tool_use');
    t.is(mapStopReason('length'), 'max_tokens');
    t.is(mapStopReason('max_tokens'), 'max_tokens');
    t.is(mapStopReason('stop_sequence'), 'stop_sequence');
    t.is(mapStopReason('stop'), 'end_turn');
    t.is(mapStopReason(undefined), 'end_turn');
    t.is(mapStopReason(null), 'end_turn');
});

test.serial('stop reason mapping in streaming: "length" maps to "max_tokens"', async (t) => {
    const requestId = 'test-anth-stopreason-' + Date.now();
    const req = createMockReq();
    const res = createMockRes();
    seedRequestState(requestId);

    processIncomingAnthropicStream(requestId, req, res, {}, 'claude-3-sonnet');
    await tick();

    await simulateEvent(requestId, 0, {
        choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
    });
    await tick();

    // Finish with "length" (OpenAI format for max tokens)
    await simulateEvent(requestId, 1, {
        choices: [{ delta: {}, finish_reason: 'length' }],
        usage: { prompt_tokens: 10, completion_tokens: 4096 },
    });
    await tick();

    const events = parseSSEEvents(res.writes);
    const msgDelta = events.find(e => e.event === 'message_delta');
    t.is(msgDelta.data.delta.stop_reason, 'max_tokens');

    t.true(res.writableEnded);
    cleanupRequestState(requestId);
});

// ============================================================================
// 5) Usage in message_delta
// ============================================================================

test.serial('streaming usage: includes input_tokens and output_tokens in message_delta', async (t) => {
    const requestId = 'test-anth-usage-' + Date.now();
    const req = createMockReq();
    const res = createMockRes();
    seedRequestState(requestId);

    processIncomingAnthropicStream(requestId, req, res, {}, 'claude-3-sonnet');
    await tick();

    await simulateEvent(requestId, 0, {
        choices: [{ delta: { content: 'Hi' }, finish_reason: null }],
    });
    await tick();

    // Complete with full usage including cache tokens
    await simulateEvent(requestId, 1, {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            cache_creation_input_tokens: 80,
            cache_read_input_tokens: 20,
        },
    });
    await tick();

    const events = parseSSEEvents(res.writes);
    const msgDelta = events.find(e => e.event === 'message_delta');
    t.truthy(msgDelta.data.usage, 'message_delta should have usage');
    t.is(msgDelta.data.usage.input_tokens, 100);
    t.is(msgDelta.data.usage.output_tokens, 50);
    t.is(msgDelta.data.usage.cache_creation_input_tokens, 80);
    t.is(msgDelta.data.usage.cache_read_input_tokens, 20);

    t.true(res.writableEnded);
    cleanupRequestState(requestId);
});

// ============================================================================
// 6) Error [ERROR] prefix
// ============================================================================

test.serial('error handling: [ERROR] requestId emits error text and closes stream', async (t) => {
    const requestId = '[ERROR] Something went wrong';
    const req = createMockReq();
    const res = createMockRes();

    processIncomingAnthropicStream(requestId, req, res, {}, 'claude-3-sonnet');
    await tick();

    const events = parseSSEEvents(res.writes);
    const eventTypes = events.map(e => e.event);

    t.true(eventTypes.includes('message_start'));
    t.true(eventTypes.includes('content_block_start'));
    t.true(eventTypes.includes('content_block_delta'));
    t.true(eventTypes.includes('content_block_stop'));
    t.true(eventTypes.includes('message_delta'));
    t.true(eventTypes.includes('message_stop'));

    // Error text should be in the delta
    const textDeltas = events.filter(e =>
        e.event === 'content_block_delta' && e.data.delta?.type === 'text_delta'
    );
    const text = textDeltas.map(e => e.data.delta.text).join('');
    t.true(text.includes('[ERROR]'));

    t.true(res.writableEnded);
});

// ============================================================================
// 7) Non-streaming usage (convertOpenAIResultToAnthropicMessage)
// ============================================================================

test.serial('non-streaming: convertOpenAIResultToAnthropicMessage includes usage data', (t) => {
    const result = convertOpenAIResultToAnthropicMessage({
        messageContent: 'Hello world',
        toolCalls: null,
        functionCall: null,
        finishReason: 'stop',
        model: 'claude-3-sonnet',
        usage: { input_tokens: 100, output_tokens: 50 },
    });

    t.is(result.type, 'message');
    t.is(result.role, 'assistant');
    t.is(result.model, 'claude-3-sonnet');
    t.is(result.usage.input_tokens, 100);
    t.is(result.usage.output_tokens, 50);
    t.is(result.stop_reason, 'end_turn');

    // Content should have text block
    t.is(result.content.length, 1);
    t.is(result.content[0].type, 'text');
    t.is(result.content[0].text, 'Hello world');
});

test.serial('non-streaming: without usage defaults to zeros', (t) => {
    const result = convertOpenAIResultToAnthropicMessage({
        messageContent: 'Test',
        toolCalls: null,
        functionCall: null,
        finishReason: 'stop',
        model: 'claude-3-sonnet',
    });

    t.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0 });
});

test.serial('non-streaming: tool_calls finish reason maps to tool_use', (t) => {
    const result = convertOpenAIResultToAnthropicMessage({
        messageContent: '',
        toolCalls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"Boston"}' },
        }],
        functionCall: null,
        finishReason: 'tool_calls',
        model: 'claude-3-sonnet',
        usage: { input_tokens: 10, output_tokens: 5 },
    });

    t.is(result.stop_reason, 'tool_use');
    const toolBlock = result.content.find(c => c.type === 'tool_use');
    t.truthy(toolBlock);
    t.is(toolBlock.name, 'get_weather');
    t.deepEqual(toolBlock.input, { location: 'Boston' });
});

test.serial('non-streaming: length finish reason maps to max_tokens', (t) => {
    const result = convertOpenAIResultToAnthropicMessage({
        messageContent: 'Truncated...',
        toolCalls: null,
        functionCall: null,
        finishReason: 'length',
        model: 'claude-3-sonnet',
        usage: { input_tokens: 10, output_tokens: 4096 },
    });

    t.is(result.stop_reason, 'max_tokens');
});

// ============================================================================
// 8) Image block conversion (convertAnthropicMessagesToOpenAI)
// ============================================================================

test.serial('image blocks: base64 image converted to OpenAI image_url format', (t) => {
    const messages = [{
        role: 'user',
        content: [
            { type: 'text', text: 'What is in this image?' },
            {
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: 'image/png',
                    data: 'iVBORw0KGgoAAAANSUhEUg==',
                },
            },
        ],
    }];

    const result = convertAnthropicMessagesToOpenAI(messages);

    t.is(result.length, 1);
    const msg = result[0];
    t.is(msg.role, 'user');

    // Content should be an array of parts (multimodal)
    t.true(Array.isArray(msg.content));
    t.is(msg.content.length, 2);

    // First part is text
    t.is(msg.content[0].type, 'text');
    t.is(msg.content[0].text, 'What is in this image?');

    // Second part is image_url
    t.is(msg.content[1].type, 'image_url');
    t.true(msg.content[1].image_url.url.startsWith('data:image/png;base64,'));
});

test.serial('image blocks: URL image converted to OpenAI image_url format', (t) => {
    const messages = [{
        role: 'user',
        content: [
            { type: 'text', text: 'Describe this.' },
            {
                type: 'image',
                source: {
                    type: 'url',
                    url: 'https://example.com/image.png',
                },
            },
        ],
    }];

    const result = convertAnthropicMessagesToOpenAI(messages);

    t.is(result.length, 1);
    const msg = result[0];
    t.true(Array.isArray(msg.content));

    const imagePart = msg.content.find(p => p.type === 'image_url');
    t.truthy(imagePart);
    t.is(imagePart.image_url.url, 'https://example.com/image.png');
});

test.serial('image blocks: text-only messages remain as string content', (t) => {
    const messages = [{
        role: 'user',
        content: [
            { type: 'text', text: 'Hello' },
        ],
    }];

    const result = convertAnthropicMessagesToOpenAI(messages);

    t.is(result.length, 1);
    // Should be a plain string, not an array
    t.is(typeof result[0].content, 'string');
    t.is(result[0].content, 'Hello');
});

// ============================================================================
// 9) message_start carries initial usage (input_tokens)
// ============================================================================

test.serial('streaming: message_start.message.usage reflects initial usage from first event', async (t) => {
    const requestId = 'test-anth-initusage-' + Date.now();
    const req = createMockReq();
    const res = createMockRes();
    seedRequestState(requestId);

    processIncomingAnthropicStream(requestId, req, res, {}, 'claude-3-sonnet');
    await tick();

    // First event carries initial usage (like Claude message_start → plugin forwards input_tokens)
    await simulateEvent(requestId, 0, {
        choices: [{ delta: { role: 'assistant', content: '' }, finish_reason: null }],
        usage: { input_tokens: 150, output_tokens: 0 },
    });
    await tick();

    // Text delta
    await simulateEvent(requestId, 0, {
        choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
    });
    await tick();

    // Final event with output usage
    await simulateEvent(requestId, 1, {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { output_tokens: 25 },
    });
    await tick();

    const events = parseSSEEvents(res.writes);

    // message_start should have the real input_tokens from the first event
    const msgStart = events.find(e => e.event === 'message_start');
    t.is(msgStart.data.message.usage.input_tokens, 150, 'message_start should carry real input_tokens');
    t.is(msgStart.data.message.usage.output_tokens, 0);

    // message_delta should have the final output_tokens
    const msgDelta = events.find(e => e.event === 'message_delta');
    t.truthy(msgDelta.data.usage, 'message_delta should have usage');
    t.is(msgDelta.data.usage.output_tokens, 25);

    t.true(res.writableEnded);
    cleanupRequestState(requestId);
});

// ============================================================================
// 10) stop_sequence preserved end-to-end
// ============================================================================

test.serial('stop reason: stop_sequence is preserved through streaming', async (t) => {
    const requestId = 'test-anth-stopseq-' + Date.now();
    const req = createMockReq();
    const res = createMockRes();
    seedRequestState(requestId);

    processIncomingAnthropicStream(requestId, req, res, {}, 'claude-3-sonnet');
    await tick();

    await simulateEvent(requestId, 0, {
        choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
    });
    await tick();

    // Finish with stop_sequence (as the plugin would now emit it)
    await simulateEvent(requestId, 1, {
        choices: [{ delta: {}, finish_reason: 'stop_sequence' }],
        usage: { input_tokens: 10, output_tokens: 3 },
    });
    await tick();

    const events = parseSSEEvents(res.writes);
    const msgDelta = events.find(e => e.event === 'message_delta');
    t.is(msgDelta.data.delta.stop_reason, 'stop_sequence');

    t.true(res.writableEnded);
    cleanupRequestState(requestId);
});

// ============================================================================
// 11) Server-side tool filtering and passthrough
// ============================================================================

test.serial('server-side tools: isServerSideTool identifies web_search_20250305', (t) => {
    t.true(isServerSideTool({ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }));
    t.false(isServerSideTool({ type: 'function', name: 'get_weather' }));
    t.false(isServerSideTool({ name: 'regular_tool', input_schema: {} }));
    t.false(isServerSideTool(null));
    t.false(isServerSideTool(undefined));
});

test.serial('server-side tools: convertAnthropicToolsToOpenAI excludes server-side tools', (t) => {
    const tools = [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
        { name: 'get_weather', description: 'Get weather info', input_schema: { type: 'object', properties: { location: { type: 'string' } } } },
    ];

    const result = convertAnthropicToolsToOpenAI(tools);

    // Should only have get_weather, not web_search
    t.is(result.length, 1);
    t.is(result[0].type, 'function');
    t.is(result[0].function.name, 'get_weather');
});

test.serial('server-side tools: convertAnthropicToolsToOpenAI returns undefined when only server-side tools', (t) => {
    const tools = [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
    ];

    const result = convertAnthropicToolsToOpenAI(tools);
    t.is(result, undefined);
});

test.serial('server-side tools: server_tool_use content blocks are ignored in message conversion (passthrough handles them)', (t) => {
    const messages = [{
        role: 'assistant',
        content: [
            { type: 'text', text: 'Let me search for that.' },
            {
                type: 'server_tool_use',
                id: 'srvtoolu_123',
                name: 'web_search',
                input: { query: 'latest news' },
            },
        ],
    }];

    const result = convertAnthropicMessagesToOpenAI(messages);

    // The assistant message should be converted, server_tool_use ignored
    t.is(result.length, 1);
    const msg = result[0];
    t.is(msg.role, 'assistant');
    t.is(msg.content, 'Let me search for that.');
    // No _anthropicServerToolBlocks - passthrough handles server tools directly
    t.falsy(msg._anthropicServerToolBlocks);
});

test.serial('server-side tools: web_search_tool_result content blocks are ignored in message conversion (passthrough handles them)', (t) => {
    const messages = [{
        role: 'user',
        content: [
            { type: 'text', text: 'Here are the results:' },
            {
                type: 'web_search_tool_result',
                tool_use_id: 'srvtoolu_123',
                content: [
                    { type: 'web_search_result', title: 'News Article', url: 'https://example.com', snippet: 'Latest news...' },
                ],
            },
        ],
    }];

    const result = convertAnthropicMessagesToOpenAI(messages);

    // The user message should be converted, web_search_tool_result ignored
    t.is(result.length, 1);
    const msg = result[0];
    t.is(msg.content, 'Here are the results:');
    // No _anthropicServerToolBlocks - passthrough handles server tools directly
    t.falsy(msg._anthropicServerToolBlocks);
});

// Note: Server-side tool streaming via _anthropic metadata is no longer needed.
// Claude clients now use native passthrough which handles thinking blocks,
// server_tool_use, and web_search_tool_result directly without conversion.
