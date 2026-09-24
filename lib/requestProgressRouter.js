// Request IDs retain the subscription API's existing authorization boundary.
// Terminal results stay in the owning process for a bounded reconnect window;
// Redis carries the same encrypted progress messages as live delivery.
export function createRequestProgressRouter({
    requestState, publishLocal, publishRemote, forwardSubscriptions,
    startRequest = (_id, state, remote) => { state.resolver?.(state.args, remote); },
    now = Date.now, retentionMs = 20 * 60 * 1000, maxResults = 1000,
}) {
    const completed = new Map();

    function terminal(requestId) {
        const entry = completed.get(requestId);
        if (entry && entry.expiresAt > now()) return entry.data;
        completed.delete(requestId);
        return null;
    }

    async function publishRequestProgress(data) {
        const state = Object.hasOwn(requestState, data?.requestId) ? requestState[data.requestId] : null;
        if (state && data.progress === 1) {
            for (const id of completed.keys()) terminal(id);
            completed.delete(data.requestId);
            completed.set(data.requestId, { data: { ...data }, expiresAt: now() + retentionMs });
            while (completed.size > maxResults) completed.delete(completed.keys().next().value);
        }
        if (publishRemote && state?.useRedis) {
            await publishRemote(data);
        } else {
            publishLocal(data);
        }
    }

    async function subscribe(requestIds, remote) {
        const missing = [];
        for (const requestId of requestIds || []) {
            const state = Object.hasOwn(requestState, requestId) ? requestState[requestId] : null;
            if (!state) { missing.push(requestId); continue; }
            // A reconnect can land on another instance after local execution
            // has started. Redis fanout also reaches the original subscriber.
            if (remote && publishRemote) state.useRedis = true;
            const result = terminal(requestId);
            if (result) {
                if (remote && publishRemote) await publishRemote(result);
                else publishLocal(result);
            } else if (!state.started) {
                state.started = true;
                state.useRedis = Boolean(remote && publishRemote);
                await startRequest(requestId, state, state.useRedis);
            }
        }
        if (!remote && missing.length && forwardSubscriptions) {
            await forwardSubscriptions(missing);
        }
    }

    return {
        publishRequestProgress,
        publishRequestProgressSubscription: (ids) => subscribe(ids, false),
        handleSubscription: (ids) => subscribe(ids, true),
    };
}
