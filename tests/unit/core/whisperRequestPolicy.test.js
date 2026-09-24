import test from 'ava';
import CortexRequest from '../../../lib/cortexRequest.js';
import { axios, executeRequest } from '../../../lib/requestExecutor.js';
import { requestState } from '../../../server/requestState.js';
import ModelPlugin from '../../../server/plugins/modelPlugin.js';
import { whisperExecutionPolicy } from '../../../lib/whisperLifecycle.js';

function request(id = 'whisper-policy') {
    const endpoint = {
        name: 'test-whisper', url: 'https://whisper.test/', data: {}, params: {}, headers: {},
        limiter: { schedule: (_options, task) => task() },
    };
    const model = { name: 'oai-whisper-ts', endpoints: [endpoint] };
    const pathway = { name: 'transcribe', timeout: 3600, enableDuplicateRequests: true };
    const req = new CortexRequest({ pathwayResolver: { requestId: id, rootRequestId: `${id}-root`, model, pathway } });
    req.executionPolicy = whisperExecutionPolicy;
    return req;
}

for (const status of [400, 403, 404, 408, 422, 500, 502, 503, 504, undefined]) {
    test.serial(`Whisper never retries an accepted or uncertain failure (${status})`, async t => {
        const original = axios.post;
        let calls = 0;
        const req = request();
        axios.post = async () => {
            calls++;
            throw Object.assign(new Error('failed'), { response: status ? { status, headers: {}, data: {} } : undefined });
        };
        try {
            await t.throwsAsync(executeRequest(req));
            t.is(calls, 1);
        } finally { axios.post = original; }
    });
}

test.serial('Whisper has one bounded busy retry budget and a real HTTP timeout', async t => {
    const original = axios.post;
    let calls = 0;
    axios.post = async (_url, _data, options) => {
        calls++;
        t.is(options.timeout, 260000);
        throw { response: { status: 429, headers: { 'retry-after': '0' }, data: {} } };
    };
    try {
        await t.throwsAsync(executeRequest(request()));
        t.is(calls, 3);
    } finally { axios.post = original; }
});

test.serial('Whisper may retry busy then return a successful result', async t => {
    const original = axios.post;
    let calls = 0;
    axios.post = async () => {
        if (++calls === 1) throw { response: { status: 429, headers: { 'retry-after': '0' }, data: {} } };
        return { status: 200, data: 'transcript' };
    };
    try {
        t.is((await executeRequest(request())).data, 'transcript');
        t.is(calls, 2);
    } finally { axios.post = original; }
});

test.serial('non-streaming cancellation aborts the current chunk without retry', async t => {
    const original = axios.post;
    const req = request('cancel-whisper');
    let calls = 0;
    let sent;
    const started = new Promise(resolve => { sent = resolve; });
    axios.post = async (_url, _data, options) => {
        calls++;
        sent();
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('cancelled'), { code: 'ERR_CANCELED', name: 'CanceledError' }));
        }, { once: true }));
    };
    try {
        const pending = executeRequest(req);
        const outcome = t.throwsAsync(pending);
        await started;
        requestState['cancel-whisper-root'].abortRequest();
        await outcome;
        t.is(calls, 1);
    } finally { axios.post = original; }
});

test.serial('settled acknowledgement survives ModelPlugin error wrapping', async t => {
    const original = axios.post;
    const req = request();
    const plugin = new ModelPlugin(req.pathway, req.model);
    axios.post = async () => { throw { response: { status: 504, headers: { 'x-whisper-job-settled': 'true' }, data: { detail: 'Source download timed out' } } }; };
    try {
        const failure = await t.throwsAsync(plugin.executeRequest(req));
        t.is(failure.status, 504);
        t.is(failure.headers['x-whisper-job-settled'], 'true');
        t.regex(failure.message, /Source download timed out/);
    } finally { axios.post = original; }
});
