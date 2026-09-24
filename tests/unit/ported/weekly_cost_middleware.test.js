import test from 'ava';
import { EventEmitter } from 'node:events';
import { createWeeklyCostMiddleware, markWeeklyCostUpstreamRejected } from '../../../server/rest/weeklyCostMiddleware.js';
function response() {
    const res = new EventEmitter();
    Object.assign(res, { statusCode: 200, headers: {}, set(name, value) { this.headers[name] = value; return this; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, write() {}, end() {} });
    return res;
}
test('cap rejection happens before handlers and returns reset details', async t => {
    const end = new Date(Date.now() + 60_000);
    const limits = { admit: async () => { throw Object.assign(new Error('cap'), { code: 'weekly_cost_limit_exceeded', budget: { end, weeklyUsd: 500, spentMicros: 501_000_000 } }); } };
    const res = response(); let called = false;
    await createWeeklyCostMiddleware(limits)({ cortexApiKeyId: 'key' }, res, () => { called = true; });
    t.false(called); t.is(res.statusCode, 429); t.is(res.body.error.estimated_spend_usd, 501); t.is(res.body.error.resets_at, end.toISOString()); t.true(Number(res.headers['Retry-After']) > 0);
});
test('unexpected middleware failure returns a service error', async t => {
    const res = response(); let called = false;
    await createWeeklyCostMiddleware({ admit: async () => { throw new Error('offline'); } })({}, res, () => { called = true; });
    t.false(called); t.is(res.statusCode, 503);
});
test('disconnect and finish callbacks report unmetered requests once without a debit', async t => {
    const records = [], missing = []; const req = { body: { model: 'missing', messages: [{ content: 'hello' }] } }; const res = response();
    const limits = { admit: async () => ({}), record: async (request, usage) => { request.weeklyCostRecorded = true; records.push(usage); } };
    await createWeeklyCostMiddleware(limits, { onMissingUsage: event => missing.push(event) })(req, res, () => {});
    req.weeklyCostUpstreamStarted = true; res.write('some output'); res.emit('close'); res.emit('finish');
    t.is(records.length, 0); t.is(missing.length, 1); t.falsy(req.weeklyCostRecorded);
});
test('validation failures do not spend allowance and real usage prevents fallback', async t => {
    let count = 0; const limits = { admit: async () => ({}), record: async () => { count++; } };
    const req = { body: {} }; const res = response();
    await createWeeklyCostMiddleware(limits)(req, res, () => {});
    res.statusCode = 400; res.end('invalid model'); res.emit('finish'); t.is(count, 0);
    req.weeklyCostRecorded = true; req.weeklyCostUpstreamStarted = true; res.emit('close'); t.is(count, 0);
});

for (const status of [400, 401, 403, 404, 422, 429]) {
    for (const stream of [false, true]) {
        test(`provider ${status} rejection does not debit allowance (stream=${stream})`, async t => {
            const records = [];
            const req = { body: { model: 'missing', previous_response_id: 'invalid-id', input: 'hello', stream } };
            const res = response();
            const limits = { admit: async () => ({}), record: async (request, usage) => { records.push(usage); } };
            await createWeeklyCostMiddleware(limits)(req, res, () => {});
            req.weeklyCostUpstreamStarted = true;
            markWeeklyCostUpstreamRejected(req, { response: { status } });
            // Streaming passthrough wraps provider errors in an HTTP 200 SSE body.
            res.statusCode = stream ? 200 : status;
            res.end(stream ? 'event: error\ndata: {"error":"rejected"}\n\n' : '{"error":"rejected"}');
            res.emit('finish'); res.emit('close');
            t.is(records.length, 0);
        });
    }
}
test('timeouts and uncertain provider failures are flagged without inventing token usage', async t => {
    for (const status of [undefined, 408, 500, 502, 504]) {
        const records = [], missing = [];
        const req = { body: { model: 'missing', input: 'hello' } };
        const res = response();
        const limits = { admit: async () => ({}), record: async (request, usage) => { request.weeklyCostRecorded = true; records.push(usage); } };
        await createWeeklyCostMiddleware(limits, { onMissingUsage: event => missing.push(event) })(req, res, () => {});
        req.weeklyCostUpstreamStarted = true;
        markWeeklyCostUpstreamRejected(req, status ? { response: { status } } : new Error('connection reset'));
        res.statusCode = status || 500;
        res.emit('close'); res.emit('finish');
        t.is(records.length, 0);
        t.is(missing.length, 1);
    }
});
