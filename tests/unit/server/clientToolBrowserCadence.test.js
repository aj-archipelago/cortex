import test from 'ava';
import sinon from 'sinon';
import { getClientToolWaitOptions } from '../../../lib/pathwayTools.js';
import { waitForClientToolResult, recordClientToolHeartbeat, resolveClientToolCallback, getPendingCallbackCount } from '../../../server/clientToolCallbacks.js';

test.serial('ordinary client tools survive one-minute background heartbeats', async t => {
    const clock = sinon.useFakeTimers({ now: 1700000000000 });
    try {
        const waiting = waitForClientToolResult('background', 'request', getClientToolWaitOptions({}));
        const outcome = waiting.catch(error => error);
        await recordClientToolHeartbeat('background', 'request');
        await clock.tickAsync(60_000);
        t.is(getPendingCallbackCount(), 1);
        await recordClientToolHeartbeat('background', 'request');
        await clock.tickAsync(60_000);
        await resolveClientToolCallback('background', { success: true, data: 'done' });
        t.deepEqual(await outcome, { success: true, data: 'done' });
        t.is(getPendingCallbackCount(), 0);
    } finally {
        clock.restore();
    }
});

test.serial('unacknowledged client tools still fail within the initial deadline', async t => {
    const clock = sinon.useFakeTimers({ now: 1700000000000 });
    try {
        const outcome = waitForClientToolResult('missing-client', 'request', getClientToolWaitOptions({})).catch(error => error);
        await clock.tickAsync(16_000);
        t.regex((await outcome).message, /no client heartbeat within 15000ms/);
        t.is(getPendingCallbackCount(), 0);
    } finally {
        clock.restore();
    }
});

test.serial('stale acknowledged tools still expire and heartbeats never extend the hard timeout', async t => {
    const clock = sinon.useFakeTimers({ now: 1700000000000 });
    try {
        const stale = waitForClientToolResult('stale', 'request', getClientToolWaitOptions({})).catch(error => error);
        await recordClientToolHeartbeat('stale', 'request');
        await clock.tickAsync(91_000);
        t.regex((await stale).message, /no client heartbeat for 90000ms/);

        const capped = waitForClientToolResult('capped', 'request', getClientToolWaitOptions({ timeout: 120_000 })).catch(error => error);
        await recordClientToolHeartbeat('capped', 'request');
        await clock.tickAsync(60_000);
        await recordClientToolHeartbeat('capped', 'request');
        await clock.tickAsync(60_000);
        t.regex((await capped).message, /execution timeout after 120000ms/);
        t.is(getPendingCallbackCount(), 0);
    } finally {
        clock.restore();
    }
});
