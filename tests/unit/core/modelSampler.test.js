import test from 'ava';
import CortexRequest from '../../../lib/cortexRequest.js';
import { runWithLimiter } from '../../../lib/requestExecutor.js';
import { jitteredDelayMs } from '../../../lib/modelSampler.js';
import { withTimeout } from '../../../lib/modelStreamPing.js';

test('sampler requests bypass endpoint limiter scheduling', async (t) => {
    let scheduleCalled = false;
    const cortexRequest = new CortexRequest({ bypassLimiter: true });
    const endpoint = {
        limiter: {
            schedule() {
                scheduleCalled = true;
                throw new Error('limiter should not be used');
            },
        },
    };

    const result = await runWithLimiter(cortexRequest, endpoint, {}, async () => 'sampled');

    t.is(result, 'sampled');
    t.false(scheduleCalled);
});

test('normal requests still schedule through endpoint limiter', async (t) => {
    let scheduleCalled = false;
    const cortexRequest = new CortexRequest();
    const endpoint = {
        limiter: {
            schedule(_options, task) {
                scheduleCalled = true;
                return task();
            },
        },
    };

    const result = await runWithLimiter(cortexRequest, endpoint, {}, async () => 'limited');

    t.is(result, 'limited');
    t.true(scheduleCalled);
});

test('sampler execute timeout rejects bounded hangs', async (t) => {
    const error = await t.throwsAsync(
        withTimeout(new Promise(() => {}), 5, 'sampler timed out'),
    );

    t.is(error.message, 'sampler timed out');
});

test('sampler interval jitter spreads timer by twenty percent either way', (t) => {
    t.is(jitteredDelayMs(1000, () => 0), 800);
    t.is(jitteredDelayMs(1000, () => 0.5), 1000);
    t.is(jitteredDelayMs(1000, () => 1), 1200);
});
