import test from 'ava';
import sinon from 'sinon';
import axios from 'axios';
import ReplicateApiPlugin from '../../../server/plugins/replicateApiPlugin.js';
import { createRequestProgressRouter } from '../../../lib/requestProgressRouter.js';

function setup(t, statusAtTime) {
    const clock = sinon.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const originalGet = axios.get;
    const events = [];
    const router = createRequestProgressRouter({
        requestState: { root: { useRedis: true } },
        publishLocal: () => t.fail('root progress should use Redis fanout'),
        publishRemote: async data => events.push(data),
    });
    axios.get = async () => ({ data: statusAtTime(clock.now) });
    t.teardown(() => { axios.get = originalGet; clock.restore(); });
    const plugin = new ReplicateApiPlugin(
        { name: 'video_seedance', model: 'replicate-seedance-2.0', inputParameters: {} },
        { name: 'replicate-seedance-2.0', type: 'REPLICATE-API', metadata: { category: 'video' } },
    );
    plugin.getRequestParameters = () => ({ input: {} });
    plugin.executeRequest = async () => ({ output_text: JSON.stringify({
        id: 'prediction', status: 'processing', urls: { get: 'https://provider.test/prediction' },
    }) });
    const request = { headers: {}, pathwayResolver: {
        requestId: 'child', rootRequestId: 'root',
        publishNestedRequestProgress: router.publishRequestProgress,
    } };
    return { clock, plugin, request, events };
}

test.serial('a 26 minute Seedance prediction completes and sends live progress to the root request', async t => {
    const { clock, plugin, request, events } = setup(t, now => now >= 26 * 60_000
        ? { status: 'succeeded', output: 'https://provider.test/result.mp4' }
        : { status: 'processing' });
    const result = plugin.execute('', {}, {}, request);
    await clock.tickAsync(26 * 60_000);
    t.is((await result).artifacts[0].url, 'https://provider.test/result.mp4');
    t.true(events.length > 100);
    t.true(events.every(event => event.requestId === 'root' && event.progress !== 1));
});

test.serial('a video provider that never finishes reaches the 30 minute polling deadline', async t => {
    const { clock, plugin, request } = setup(t, () => ({ status: 'processing' }));
    const result = plugin.execute('', {}, {}, request).catch(error => error);
    await clock.tickAsync(30 * 60_000);
    t.regex((await result).message, /timed out after 1800 seconds/);
});

test.serial('provider moderation failure is terminal and is not retried', async t => {
    let calls = 0;
    const { clock, plugin, request } = setup(t, () => {
        calls++;
        return { status: 'failed', error: 'The input or output was flagged as sensitive. (E005)' };
    });
    const result = plugin.execute('', {}, {}, request).catch(error => error);
    await clock.tickAsync(1);
    t.regex((await result).message, /E005/);
    t.is(calls, 1);
});
