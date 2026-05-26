import test from 'ava';
import { PassThrough } from 'stream';
import CortexRequest from '../../../lib/cortexRequest.js';
import { axios, executeRequest } from '../../../lib/requestExecutor.js';
import { PathwayResolver } from '../../../server/pathwayResolver.js';
import { requestState } from '../../../server/requestState.js';
import { cancelRequestResolver } from '../../../server/resolver.js';

test.serial('cancelRequest marks request canceled and invokes abort hook', (t) => {
    const requestId = 'cancel-abort-hook';
    let abortCalled = false;
    requestState[requestId] = {
        abortRequest() {
            abortCalled = true;
        },
    };

    try {
        const result = cancelRequestResolver(null, { requestId }, { requestState });

        t.true(result);
        t.true(requestState[requestId].canceled);
        t.true(abortCalled);
    } finally {
        delete requestState[requestId];
    }
});

test.serial('streaming model request registers abortable provider signal', async (t) => {
    const requestId = 'stream-abort-signal';
    const originalPost = axios.post;
    let capturedSignal = null;

    axios.post = async (_url, _data, options) => {
        capturedSignal = options.signal;
        return {
            status: 200,
            data: new PassThrough(),
        };
    };

    const endpoint = {
        name: 'test-endpoint',
        url: 'https://example.test/responses',
        data: {},
        params: {},
        headers: {},
        limiter: {
            schedule(_options, task) {
                return task();
            },
        },
    };
    const model = {
        name: 'test-stream-model',
        supportsStreaming: true,
        endpoints: [endpoint],
    };
    const cortexRequest = new CortexRequest({
        data: { stream: true },
        model,
        pathwayResolver: {
            requestId,
            model,
            pathway: { timeout: 120 },
        },
    });

    try {
        await executeRequest(cortexRequest);

        t.truthy(capturedSignal);
        t.false(capturedSignal.aborted);
        t.is(typeof requestState[requestId]?.abortRequest, 'function');

        cancelRequestResolver(null, { requestId }, { requestState });

        t.true(capturedSignal.aborted);
        t.true(requestState[requestId].canceled);
    } finally {
        axios.post = originalPost;
        delete requestState[requestId];
    }
});

test.serial('nested streaming model request registers abort hook on root request id', async (t) => {
    const rootRequestId = 'stream-abort-root-signal';
    const childRequestId = 'stream-abort-child-signal';
    const originalPost = axios.post;
    let capturedSignal = null;

    axios.post = async (_url, _data, options) => {
        capturedSignal = options.signal;
        return new Promise((_resolve, reject) => {
            capturedSignal.addEventListener('abort', () => {
                const error = new Error('canceled');
                error.name = 'CanceledError';
                error.code = 'ERR_CANCELED';
                reject(error);
            }, { once: true });
        });
    };

    const endpoint = {
        name: 'test-endpoint',
        url: 'https://example.test/responses',
        data: {},
        params: {},
        headers: {},
        limiter: {
            schedule(_options, task) {
                return task();
            },
        },
    };
    const model = {
        name: 'test-stream-model',
        supportsStreaming: true,
        endpoints: [endpoint],
    };
    const cortexRequest = new CortexRequest({
        data: { stream: true },
        model,
        pathwayResolver: {
            requestId: childRequestId,
            rootRequestId,
            model,
            pathway: { timeout: 120 },
        },
    });

    try {
        const requestPromise = executeRequest(cortexRequest);
        await new Promise((resolve) => setImmediate(resolve));

        t.truthy(capturedSignal);
        t.false(capturedSignal.aborted);
        t.is(typeof requestState[rootRequestId]?.abortRequest, 'function');
        t.is(typeof requestState[childRequestId]?.abortRequest, 'function');

        cancelRequestResolver(null, { requestId: rootRequestId }, { requestState });

        const error = await requestPromise.then(
            () => null,
            (rejection) => rejection,
        );
        t.truthy(error);
        t.is(error.name, 'CanceledError');
        t.true(capturedSignal.aborted);
        t.true(requestState[rootRequestId].canceled);
    } finally {
        axios.post = originalPost;
        delete requestState[rootRequestId];
        delete requestState[childRequestId];
    }
});

test.serial('streaming provider cancellation does not retry after abort', async (t) => {
    const requestId = 'stream-abort-no-retry';
    const originalPost = axios.post;
    let callCount = 0;
    let capturedSignal = null;

    axios.post = async (_url, _data, options) => {
        callCount += 1;

        if (callCount > 1) {
            throw new Error('provider call retried after cancellation');
        }

        capturedSignal = options.signal;
        return new Promise((_resolve, reject) => {
            capturedSignal.addEventListener('abort', () => {
                const error = new Error('canceled');
                error.name = 'CanceledError';
                error.code = 'ERR_CANCELED';
                reject(error);
            }, { once: true });
        });
    };

    const endpoint = {
        name: 'test-endpoint',
        url: 'https://example.test/responses',
        data: {},
        params: {},
        headers: {},
        limiter: {
            schedule(_options, task) {
                return task();
            },
        },
    };
    const model = {
        name: 'test-stream-model',
        supportsStreaming: true,
        endpoints: [endpoint],
    };
    const cortexRequest = new CortexRequest({
        data: { stream: true },
        model,
        pathwayResolver: {
            requestId,
            model,
            pathway: { timeout: 120 },
        },
    });

    try {
        const requestPromise = executeRequest(cortexRequest);
        await new Promise((resolve) => setImmediate(resolve));

        t.truthy(capturedSignal);
        cancelRequestResolver(null, { requestId }, { requestState });

        const error = await requestPromise.then(
            () => null,
            (rejection) => rejection,
        );
        t.truthy(error);
        t.is(error.name, 'CanceledError');
        t.is(callCount, 1);
    } finally {
        axios.post = originalPost;
        delete requestState[requestId];
    }
});

test.serial('cancelRequest destroys active provider stream', async (t) => {
    const requestId = 'stream-abort-active-provider';
    const stream = new PassThrough();
    let previousAbortCalled = false;

    requestState[requestId] = {
        abortRequest() {
            previousAbortCalled = true;
        },
    };

    const pathwayResolver = Object.create(PathwayResolver.prototype);
    Object.assign(pathwayResolver, {
        requestId,
        rootRequestId: null,
        pathway: { name: 'test-pathway' },
        modelName: 'test-stream-model',
        modelExecutor: {
            plugin: {
                processStreamEvent(_event, requestProgress) {
                    return requestProgress;
                },
            },
        },
        pathwayResultData: {},
        errors: [],
        publishNestedRequestProgress() {},
    });

    try {
        const streamPromise = pathwayResolver.handleStream(stream);
        await new Promise((resolve) => setImmediate(resolve));

        cancelRequestResolver(null, { requestId }, { requestState });
        await streamPromise;

        t.true(previousAbortCalled);
        t.true(stream.destroyed);
        t.true(requestState[requestId].canceled);
        t.is(requestState[requestId].abortRequest, undefined);
    } finally {
        delete requestState[requestId];
    }
});

test.serial('handleStream keeps active streams alive past pathway timeout', async (t) => {
    const requestId = 'stream-active';
    const stream = new PassThrough();
    let publishCount = 0;

    requestState[requestId] = {};

    const pathwayResolver = Object.create(PathwayResolver.prototype);
    Object.assign(pathwayResolver, {
        requestId,
        rootRequestId: null,
        pathway: { name: 'test-pathway', timeout: 0.01 },
        modelName: 'test-stream-model',
        modelExecutor: {
            plugin: {
                processStreamEvent(event, requestProgress) {
                    const payload = JSON.parse(event.data);
                    requestProgress.data = event.data;
                    if (payload.done) {
                        requestProgress.progress = 1;
                    }
                    return requestProgress;
                },
            },
        },
        pathwayResultData: {},
        errors: [],
        publishNestedRequestProgress() {
            publishCount += 1;
        },
    });

    try {
        const streamPromise = pathwayResolver.handleStream(stream);
        stream.write('data: {"chunk":1}\n\n');

        await new Promise((resolve) => setTimeout(resolve, 35));
        t.false(stream.destroyed);

        stream.write('data: {"chunk":2}\n\n');
        await new Promise((resolve) => setTimeout(resolve, 35));
        t.false(stream.destroyed);

        stream.write('data: {"done":true}\n\n');

        const result = await streamPromise;

        t.true(result.success);
        t.true(stream.destroyed);
        t.is(publishCount, 3);
    } finally {
        delete requestState[requestId];
    }
});

test.serial('handleStream resolves and destroys stream after terminal progress event', async (t) => {
    const requestId = 'stream-terminal-event';
    const stream = new PassThrough();

    requestState[requestId] = {};

    const pathwayResolver = Object.create(PathwayResolver.prototype);
    Object.assign(pathwayResolver, {
        requestId,
        rootRequestId: null,
        pathway: { name: 'test-pathway', timeout: 120 },
        modelName: 'test-stream-model',
        modelExecutor: {
            plugin: {
                processStreamEvent(_event, requestProgress) {
                    requestProgress.data = JSON.stringify({ done: true });
                    requestProgress.progress = 1;
                    return requestProgress;
                },
            },
        },
        pathwayResultData: {},
        errors: [],
        publishNestedRequestProgress() {},
    });

    try {
        const streamPromise = pathwayResolver.handleStream(stream);
        stream.write('data: {"type":"response.completed"}\n\n');

        const result = await streamPromise;

        t.true(stream.destroyed);
        t.true(result.success);
        t.is(requestState[requestId].abortRequest, undefined);
    } finally {
        delete requestState[requestId];
    }
});
