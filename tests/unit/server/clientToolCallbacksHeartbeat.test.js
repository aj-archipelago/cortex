import test from 'ava';
import {
    getPendingCallbackCount,
    recordClientToolHeartbeat,
    resolveClientToolCallback,
    waitForClientToolResult,
} from '../../../server/clientToolCallbacks.js';

const requestId = 'heartbeat-test-request';

test.serial('client tool wait fails fast when no heartbeat arrives', async t => {
    const toolCallbackId = `no-heartbeat-${Date.now()}`;

    const waitPromise = waitForClientToolResult(toolCallbackId, requestId, {
        maxTimeoutMs: 1000,
        initialHeartbeatTimeoutMs: 100,
        heartbeatStaleMs: 1000,
        checkEveryMs: 20,
    });

    const error = await t.throwsAsync(waitPromise);
    t.regex(error.message, /CLIENT_TOOL_HEARTBEAT_TIMEOUT/);
    t.regex(error.message, /unconfirmed, not necessarily failed/);
    t.is(getPendingCallbackCount(), 0);
});

test.serial('client tool wait resolves while heartbeat monitoring is enabled', async t => {
    const toolCallbackId = `heartbeat-result-${Date.now()}`;
    const waitPromise = waitForClientToolResult(toolCallbackId, requestId, {
        maxTimeoutMs: 1000,
        initialHeartbeatTimeoutMs: 200,
        heartbeatStaleMs: 500,
        checkEveryMs: 20,
    });

    await recordClientToolHeartbeat(toolCallbackId, requestId);

    const result = {
        success: true,
        data: { message: 'ok' },
        error: null,
    };
    await resolveClientToolCallback(toolCallbackId, result);

    t.deepEqual(await waitPromise, result);
    t.is(getPendingCallbackCount(), 0);
});
