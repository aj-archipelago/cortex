// responsesStreaming.test.js
// Unit tests for processIncomingResponsesStream (Responses API SSE streaming)

import test from 'ava';
import pubsub from '../../../server/pubsub.js';
import { requestState } from '../../../server/requestState.js';
import { processIncomingResponsesStream } from '../../../server/rest/openaiResponsesRoute.js';

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
    path: '/v1/responses',
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

// Yield once to let local pubsub handlers run.
const tick = () => new Promise(resolve => setImmediate(resolve));

// ============================================================================
// a) Text streaming (baseline)
// ============================================================================

test.serial('text streaming: emits correct SSE event sequence for text deltas', async (t) => {
    const requestId = 'test-text-' + Date.now();
    const req = createMockReq();
    const res = createMockRes();
    seedRequestState(requestId);

    processIncomingResponsesStream(requestId, req, res, {}, 'test-model', 'resp-test-1');
    await tick();

    // Send text deltas
    await simulateEvent(requestId, 0, { type: 'response.output_text.delta', delta: 'Hello' });
    await tick();
    await simulateEvent(requestId, 0, { type: 'response.output_text.delta', delta: ' world' });
    await tick();

    // Complete
    await simulateEvent(requestId, 1, {
        type: 'response.completed',
        response: { output: [], output_text: 'Hello world', usage: { input_tokens: 5, output_tokens: 2 } },
    });
    await tick();

    const events = parseSSEEvents(res.writes);
    const eventTypes = events.map(e => e.event);

    // Verify ordering: created → output_item.added → content_part.added → deltas → content_part.done → output_item.done → done
    t.true(eventTypes.includes('response.created'), 'should have response.created');
    t.true(eventTypes.includes('response.output_item.added'), 'should have output_item.added');
    t.true(eventTypes.includes('response.content_part.added'), 'should have content_part.added');
    t.true(eventTypes.includes('response.output_text.delta'), 'should have text deltas');
    t.true(eventTypes.includes('response.content_part.done'), 'should have content_part.done');
    t.true(eventTypes.includes('response.output_item.done'), 'should have output_item.done');
    t.true(eventTypes.includes('response.done'), 'should have response.done');

    const createdIdx = eventTypes.indexOf('response.created');
    const doneIdx = eventTypes.lastIndexOf('response.done');
    t.true(createdIdx < doneIdx);

    // Verify response.done output_text matches accumulated deltas
    const doneEvent = events.find(e => e.event === 'response.done');
    t.is(doneEvent.data.response.output_text, 'Hello world');
    t.is(doneEvent.data.response.status, 'completed');
    t.truthy(doneEvent.data.response.usage);

    // Verify delta events
    const deltaEvents = events.filter(e => e.event === 'response.output_text.delta');
    const accumulated = deltaEvents.map(e => e.data.delta).join('');
    t.is(accumulated, 'Hello world');

    t.true(res.writableEnded);
    cleanupRequestState(requestId);
});

// ============================================================================
// b) Native function call streaming
// ============================================================================

test.serial('native function call streaming: forwards function call events to client', async (t) => {
    const requestId = 'test-fc-native-' + Date.now();
    const req = createMockReq();
    const res = createMockRes();
    seedRequestState(requestId);

    processIncomingResponsesStream(requestId, req, res, {}, 'test-model', 'resp-test-2');
    await tick();

    // Simulate native function call events
    await simulateEvent(requestId, 0, {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', call_id: 'call_123', name: 'get_weather', arguments: '', status: 'in_progress' },
    });
    await tick();

    await simulateEvent(requestId, 0, {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"loc',
    });
    await tick();

    await simulateEvent(requestId, 0, {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: 'ation":"Boston"}',
    });
    await tick();

    await simulateEvent(requestId, 0, {
        type: 'response.function_call_arguments.done',
        output_index: 0,
        arguments: '{"location":"Boston"}',
    });
    await tick();

    await simulateEvent(requestId, 0, {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', call_id: 'call_123', name: 'get_weather', arguments: '{"location":"Boston"}', status: 'completed' },
    });
    await tick();

    // Complete
    await simulateEvent(requestId, 1, {
        type: 'response.completed',
        response: { output: [], usage: { input_tokens: 10, output_tokens: 5 } },
    });
    await tick();

    const events = parseSSEEvents(res.writes);
    const eventTypes = events.map(e => e.event);

    // Verify function call events forwarded
    t.true(eventTypes.includes('response.output_item.added'), 'should have output_item.added');
    t.true(eventTypes.includes('response.function_call_arguments.delta'), 'should have fc arguments delta');
    t.true(eventTypes.includes('response.function_call_arguments.done'), 'should have fc arguments done');

    // Verify output_item.added is for function_call
    const addedEvent = events.find(e => e.event === 'response.output_item.added');
    t.is(addedEvent.data.item.type, 'function_call');
    t.is(addedEvent.data.item.call_id, 'call_123');

    // Verify response.done output includes the function_call item
    const doneEvent = events.find(e => e.event === 'response.done');
    const fcOutput = doneEvent.data.response.output.find(o => o.type === 'function_call');
    t.truthy(fcOutput, 'response.done output should include function_call');
    t.is(fcOutput.name, 'get_weather');
    t.is(fcOutput.arguments, '{"location":"Boston"}');

    // No text message scaffold should be created
    t.false(eventTypes.includes('response.content_part.added'), 'should NOT have content_part.added for function-only call');

    t.true(res.writableEnded);
    cleanupRequestState(requestId);
});

// ============================================================================
// c) Chat completion format tool calls
// ============================================================================

test.serial('chat completion format tool calls: emits function call events from delta.tool_calls', async (t) => {
    const requestId = 'test-fc-chat-' + Date.now();
    const req = createMockReq();
    const res = createMockRes();
    seedRequestState(requestId);

    processIncomingResponsesStream(requestId, req, res, {}, 'test-model', 'resp-test-3');
    await tick();

    // Simulate chat completion format tool_calls deltas
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

    await simulateEvent(requestId, 0, {
        choices: [{
            delta: {
                tool_calls: [{
                    index: 0,
                    function: { arguments: '{"loc' },
                }],
            },
            finish_reason: null,
        }],
    });
    await tick();

    await simulateEvent(requestId, 0, {
        choices: [{
            delta: {
                tool_calls: [{
                    index: 0,
                    function: { arguments: 'ation":"Boston"}' },
                }],
            },
            finish_reason: null,
        }],
    });
    await tick();

    // finish_reason: "tool_calls"
    await simulateEvent(requestId, 1, {
        choices: [{
            delta: {},
            finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    await tick();

    const events = parseSSEEvents(res.writes);
    const eventTypes = events.map(e => e.event);

    // Verify function call events emitted
    t.true(eventTypes.includes('response.output_item.added'), 'should have output_item.added');
    t.true(eventTypes.includes('response.function_call_arguments.delta'), 'should have fc arguments delta');
    t.true(eventTypes.includes('response.function_call_arguments.done'), 'should have fc arguments done');
    t.true(eventTypes.includes('response.output_item.done'), 'should have output_item.done');

    // Verify the added event is for function_call
    const addedEvent = events.find(e => e.event === 'response.output_item.added');
    t.is(addedEvent.data.item.type, 'function_call');
    t.is(addedEvent.data.item.name, 'get_weather');

    // Verify arguments deltas
    const argDeltas = events.filter(e => e.event === 'response.function_call_arguments.delta');
    t.is(argDeltas.length, 2); // two argument chunks (empty first args not sent)
    const allArgs = argDeltas.map(e => e.data.delta).join('');
    t.is(allArgs, '{"location":"Boston"}');

    // Verify arguments done
    const argsDone = events.find(e => e.event === 'response.function_call_arguments.done');
    t.is(argsDone.data.arguments, '{"location":"Boston"}');

    // Verify output_item.done
    const itemDone = events.find(e => e.event === 'response.output_item.done');
    t.is(itemDone.data.item.type, 'function_call');
    t.is(itemDone.data.item.status, 'completed');
    t.is(itemDone.data.item.arguments, '{"location":"Boston"}');

    // Verify response.done includes function_call item
    const doneEvent = events.find(e => e.event === 'response.done');
    const fcOutput = doneEvent.data.response.output.find(o => o.type === 'function_call');
    t.truthy(fcOutput, 'response.done output should include function_call');
    t.is(fcOutput.name, 'get_weather');

    t.true(res.writableEnded);
    cleanupRequestState(requestId);
});

// ============================================================================
// d) Mixed text + function calls
// ============================================================================

test.serial('mixed text and function calls: both appear in response.done output', async (t) => {
    const requestId = 'test-mixed-' + Date.now();
    const req = createMockReq();
    const res = createMockRes();
    seedRequestState(requestId);

    processIncomingResponsesStream(requestId, req, res, {}, 'test-model', 'resp-test-4');
    await tick();

    // Send text first
    await simulateEvent(requestId, 0, { type: 'response.output_text.delta', delta: 'Let me check.' });
    await tick();

    // Then native function call
    await simulateEvent(requestId, 0, {
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'function_call', call_id: 'call_mix', name: 'search', arguments: '', status: 'in_progress' },
    });
    await tick();

    await simulateEvent(requestId, 0, {
        type: 'response.function_call_arguments.done',
        output_index: 1,
        arguments: '{"q":"test"}',
    });
    await tick();

    await simulateEvent(requestId, 0, {
        type: 'response.output_item.done',
        output_index: 1,
        item: { type: 'function_call', call_id: 'call_mix', name: 'search', arguments: '{"q":"test"}', status: 'completed' },
    });
    await tick();

    // Complete
    await simulateEvent(requestId, 1, {
        type: 'response.completed',
        response: { output: [], usage: { input_tokens: 8, output_tokens: 10 } },
    });
    await tick();

    const events = parseSSEEvents(res.writes);
    const doneEvent = events.find(e => e.event === 'response.done');

    // Both text message and function call should be in output
    const messageOutput = doneEvent.data.response.output.find(o => o.type === 'message');
    const fcOutput = doneEvent.data.response.output.find(o => o.type === 'function_call');
    t.truthy(messageOutput, 'should have message in output');
    t.truthy(fcOutput, 'should have function_call in output');
    t.is(doneEvent.data.response.output_text, 'Let me check.');
    t.is(fcOutput.name, 'search');

    t.true(res.writableEnded);
    cleanupRequestState(requestId);
});

// ============================================================================
// e) Error handling
// ============================================================================

test.serial('error handling: [ERROR] requestId emits error text and closes stream', async (t) => {
    const requestId = '[ERROR] Something went wrong';
    const req = createMockReq();
    const res = createMockRes();
    // No requestState needed for error path (fireStreamResolver is not called)

    processIncomingResponsesStream(requestId, req, res, {}, 'test-model', 'resp-test-5');
    await tick();

    const events = parseSSEEvents(res.writes);
    const eventTypes = events.map(e => e.event);

    t.true(eventTypes.includes('response.created'));
    t.true(eventTypes.includes('response.output_text.delta'));
    t.true(eventTypes.includes('response.done'));

    // Error text should be in the delta and done output
    const deltaEvent = events.find(e => e.event === 'response.output_text.delta');
    t.true(deltaEvent.data.delta.includes('[ERROR]'));

    const doneEvent = events.find(e => e.event === 'response.done');
    t.true(doneEvent.data.response.output_text.includes('[ERROR]'));

    t.true(res.writableEnded);
});

// ============================================================================
// f) Completion with function calls in response (no prior streaming events)
// ============================================================================

test.serial('completion with function calls in response: extracts untracked function calls', async (t) => {
    const requestId = 'test-fc-completion-' + Date.now();
    const req = createMockReq();
    const res = createMockRes();
    seedRequestState(requestId);

    processIncomingResponsesStream(requestId, req, res, {}, 'test-model', 'resp-test-6');
    await tick();

    // Send response.completed with function calls in output, no prior streaming events
    await simulateEvent(requestId, 1, {
        type: 'response.completed',
        response: {
            output: [
                {
                    type: 'function_call',
                    call_id: 'call_bulk',
                    name: 'get_weather',
                    arguments: '{"location":"NYC"}',
                    status: 'completed',
                },
            ],
            output_text: '',
            usage: { input_tokens: 5, output_tokens: 3 },
        },
    });
    await tick();

    const events = parseSSEEvents(res.writes);
    const doneEvent = events.find(e => e.event === 'response.done');

    t.truthy(doneEvent);
    const fcOutput = doneEvent.data.response.output.find(o => o.type === 'function_call');
    t.truthy(fcOutput, 'function call should be extracted from completed response');
    t.is(fcOutput.name, 'get_weather');
    t.is(fcOutput.call_id, 'call_bulk');
    t.is(fcOutput.arguments, '{"location":"NYC"}');

    t.true(res.writableEnded);
    cleanupRequestState(requestId);
});
