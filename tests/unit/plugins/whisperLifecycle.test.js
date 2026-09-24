import test from 'ava';
import sinon from 'sinon';
import { config } from '../../../config.js';
import { axios } from '../../../lib/requestExecutor.js';
import { requestState } from '../../../server/requestState.js';

config.set('whisperMediaApiUrl', 'https://media-helper.test/');
const { default: WhisperPlugin } = await import('../../../server/plugins/openAiWhisperPlugin.js');

function setup(t, uris) {
    const endpoint = { name: 'test', url: 'https://whisper.test/', headers: {}, params: {}, limiter: { schedule: (_options, run) => run() } };
    const model = { name: 'oai-whisper-ts', endpoints: [endpoint] };
    const pathway = { name: 'transcribe', timeout: 3600, enableDuplicateRequests: true };
    const plugin = new WhisperPlugin(pathway, model);
    const pathwayResolver = { requestId: 'lifecycle', rootRequestId: 'lifecycle-root', pathway, model };
    sinon.stub(axios, 'get').resolves({ data: uris });
    const cleanup = sinon.stub(axios, 'delete').resolves({ data: {} });
    t.teardown(() => { sinon.restore(); delete requestState.lifecycle; delete requestState['lifecycle-root']; });
    return { plugin, endpoint, cleanup, run: () => plugin.execute('', { file: 'https://source.test/video', responseFormat: 'srt' }, null, { pathwayResolver }) };
}

test.serial('duplicate chunk URLs share one provider request', async t => {
    const { run, cleanup } = setup(t, ['https://chunk.test/a', 'https://chunk.test/a']);
    const post = sinon.stub(axios, 'post').resolves({ status: 200, data: '1\n00:00:00,000 --> 00:00:01,000\nHello\n' });
    await run();
    t.is(post.callCount, 1);
    t.is(cleanup.callCount, 1);
    t.true(post.firstCall.args[1].deadline > Date.now() / 1000);
});

test.serial('a failed chunk cannot clean up a still-running sibling or start the next batch', async t => {
    const uris = ['bad', 'slow', 'third', 'fourth', 'never'].map(name => `https://chunk.test/${name}`);
    const { run, cleanup } = setup(t, uris);
    let release;
    const slow = new Promise(resolve => { release = resolve; });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    const post = sinon.stub(axios, 'post').callsFake(async (_url, data) => {
        if (data.fileurl.endsWith('/bad')) throw { response: { status: 422, headers: { 'x-whisper-job-settled': 'true' }, data: {} } };
        if (data.fileurl.endsWith('/slow')) { entered(); await slow; }
        return { status: 200, data: 'transcript' };
    });
    const pending = run();
    await started;
    t.is(cleanup.callCount, 0);
    release();
    t.regex(await pending, /^Transcribe error:/);
    t.is(post.callCount, 4);
    t.is(cleanup.callCount, 1);
});

test.serial('unknown transport outcome retains blobs until deadline plus grace', async t => {
    const { run, cleanup } = setup(t, ['https://chunk.test/a']);
    const clock = sinon.useFakeTimers({ now: 10000, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const post = sinon.stub(axios, 'post').rejects(new Error('connection lost'));
    const pending = run();
    await clock.tickAsync(249999);
    t.is(post.callCount, 1);
    t.is(cleanup.callCount, 0);
    await clock.tickAsync(2);
    t.regex(await pending, /^Transcribe error:/);
    t.is(cleanup.callCount, 1);
});

test.serial('deadline begins after limiter admission and cancellation prevents queued dispatch', async t => {
    const { run, endpoint, cleanup } = setup(t, ['https://chunk.test/a']);
    let admit;
    endpoint.limiter.schedule = (_options, dispatch) => new Promise((resolve, reject) => {
        admit = () => Promise.resolve().then(dispatch).then(resolve, reject);
    });
    const post = sinon.stub(axios, 'post').resolves({ status: 200, data: 'transcript' });
    const clock = sinon.useFakeTimers({ now: 10000, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const pending = run();
    await clock.tickAsync(300000);
    admit();
    await pending;
    t.is(post.firstCall.args[1].deadline, 550);
    t.is(cleanup.callCount, 1);

    const canceled = run();
    await clock.tickAsync(1);
    requestState['lifecycle-root'].canceled = true;
    admit();
    t.regex(await canceled, /^Transcribe error:/);
    t.is(post.callCount, 1);
    t.is(cleanup.callCount, 2);
});
