import test from 'ava';
import { createRequestProgressRouter } from '../../../lib/requestProgressRouter.js';
import pubsub from '../../../server/pubsub.js';
import subscriptions from '../../../server/subscriptions.js';
import { requestState } from '../../../server/requestState.js';
import { publishRequestProgress } from '../../../lib/redisSubscription.js';

function cluster(options = {}) {
    const events = [[], []];
    const states = [{}, {}];
    const routers = states.map((state, index) => createRequestProgressRouter({
        requestState: state,
        publishLocal: data => events[index].push(data),
        publishRemote: async data => events.forEach(list => list.push(data)),
        forwardSubscriptions: async ids => Promise.all(routers.map(router => router.handleSubscription(ids))),
        ...options,
    }));
    return { events, states, routers };
}

test('reconnect to another server bridges a running local request without executing it twice', async t => {
    const { events, states, routers } = cluster();
    let starts = 0;
    states[0].video = { resolver: () => starts++ };
    await routers[0].publishRequestProgressSubscription(['video']);
    t.false(states[0].video.useRedis);
    await routers[1].publishRequestProgressSubscription(['video']);
    await routers[0].publishRequestProgress({ requestId: 'video', progress: 1, data: 'saved-media-output' });
    t.is(starts, 1);
    t.true(states[0].video.useRedis);
    t.is(events[1][0].data, 'saved-media-output');
});

test('reconnect after completion replays the full terminal result on local or remote servers', async t => {
    const { events, states, routers } = cluster();
    let starts = 0;
    states[0].video = { resolver: () => starts++ };
    await routers[0].publishRequestProgressSubscription(['video']);
    const result = { requestId: 'video', progress: 1, data: 'output', info: 'metadata', error: '' };
    await routers[0].publishRequestProgress(result);
    await routers[1].publishRequestProgressSubscription(['video']);
    t.deepEqual(events[1], [result]);
    await routers[0].publishRequestProgressSubscription(['video']);
    t.deepEqual(events[0].at(-1), result);
    t.is(starts, 1);
    await routers[1].publishRequestProgressSubscription(['unrelated', '__proto__']);
    t.is(events[1].length, 1);
});

test('terminal replay expires and is bounded; errors can also be recovered', async t => {
    let time = 0;
    const { events, states, routers } = cluster({ now: () => time, retentionMs: 100, maxResults: 1 });
    for (const id of ['old', 'recent']) {
        states[0][id] = { started: true };
        await routers[0].publishRequestProgress({ requestId: id, progress: 1, error: 'provider failure' });
    }
    await routers[1].publishRequestProgressSubscription(['old']);
    t.is(events[1].length, 0);
    await routers[1].publishRequestProgressSubscription(['recent']);
    t.is(events[1][0].error, 'provider failure');
    time = 101;
    await routers[1].publishRequestProgressSubscription(['recent']);
    t.is(events[1].length, 1);
});

test.serial('real GraphQL iterator installs its listener before synchronous execution or terminal replay', async t => {
    const id = 'iterator-replay-test';
    requestState[id] = { resolver: () => publishRequestProgress({ requestId: id, progress: 1, data: 'result' }) };
    for (let i = 0; i < 2; i++) {
        const iterator = await subscriptions.requestProgress.subscribe(null, { requestIds: [id] });
        const next = await iterator.next();
        t.is(next.value.requestProgress.data, 'result');
        await iterator.return();
    }
    delete requestState[id];
    t.is(pubsub.ee.listenerCount('REQUEST_PROGRESS'), 0);
});
