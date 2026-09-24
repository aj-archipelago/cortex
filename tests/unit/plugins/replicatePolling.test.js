import test from 'ava';
import sinon from 'sinon';
import axios from 'axios';
import ReplicateApiPlugin from '../../../server/plugins/replicateApiPlugin.js';

function setup(t) {
    const clock = sinon.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const plugin = new ReplicateApiPlugin({ name: 'media_replicate', model: 'replicate-seedance-2.5' }, { name: 'replicate-seedance-2.5', metadata: { category: 'video' } });
    sinon.stub(plugin, 'getRequestParameters').returns({});
    sinon.stub(plugin, 'executeRequest').resolves({ output_text: JSON.stringify({ id: 'prediction', status: 'processing', urls: { get: 'https://api.replicate.com/prediction' } }) });
    sinon.stub(plugin, 'parseResponse').callsFake(value => value);
    sinon.stub(plugin, 'createCortexResponse').callsFake(value => value);
    const progress = [];
    const request = { headers: {}, pathwayResolver: { requestId: 'child', rootRequestId: 'root', publishNestedRequestProgress: data => progress.push(data), isCanceled: () => false } };
    t.teardown(() => { sinon.restore(); clock.restore(); });
    return { clock, plugin, progress, request };
}

test.serial('video polling stays live past twenty minutes and delivers the provider output', async t => {
    const { clock, plugin, progress, request } = setup(t);
    const get = sinon.stub(axios, 'get').callsFake(async () => Date.now() >= 26 * 60_000 ? { data: { status: 'succeeded', output: ['https://example.com/video.mp4'] } } : { data: { status: 'processing' } });
    const result = plugin.execute('', {}, {}, request);
    await clock.tickAsync(26 * 60_000);
    t.deepEqual((await result).output, ['https://example.com/video.mp4']);
    t.true(progress.length > 120);
    t.true(progress.every(event => event.requestId === 'root' && !event.progress && !event.data));
    t.true(get.args.every(([, options]) => options.timeout > 0 && options.timeout <= 30_000));
});

test.serial('provider deadline includes time spent waiting for HTTP responses', async t => {
    const { clock, plugin, request } = setup(t);
    sinon.stub(axios, 'get').callsFake(async () => {
        await new Promise(resolve => setTimeout(resolve, 20_000));
        return { data: { status: 'processing' } };
    });
    const result = t.throwsAsync(plugin.execute('', {}, {}, request), { message: /timed out after 1800 seconds/ });
    await clock.tickAsync(1800_000);
    await result;
});

test.serial('cancellation stops further provider polling', async t => {
    const { plugin, request } = setup(t);
    request.pathwayResolver.isCanceled = () => true;
    const get = sinon.stub(axios, 'get');
    await t.throwsAsync(plugin.execute('', {}, {}, request), { message: 'Prediction canceled' });
    t.false(get.called);
});
