import test from 'ava';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { config } from '../../../config.js';
import { createWeeklyCostMiddleware, weeklyCostLimits } from '../../../server/rest/weeklyCostMiddleware.js';
import tokenUsageStore from '../../../lib/TokenUsageStore.js';

config.set('storageConnectionString', '');
config.set('enableCache', false);
const { axios, modelEndpoints } = await import('../../../lib/requestExecutor.js');
const { registerOpenAIResponsesRoute } = await import('../../../server/rest/openaiResponsesRoute.js');

function response() {
    return Object.assign(new EventEmitter(), {
        statusCode: 200, headersSent: false, writableEnded: false, chunks: [],
        setHeader() {}, flushHeaders() { this.headersSent = true; },
        status(code) { this.statusCode = code; return this; },
        write(chunk) { this.chunks.push(chunk); return true; },
        end(chunk) { if (chunk) this.write(chunk); this.writableEnded = true; this.emit('finish'); },
        json(body) { this.end(JSON.stringify(body)); return this; },
    });
}

test('large SSE frames, image data, and opaque context never become token debits', async t => {
    for (const previousResponse of [undefined, 'resp_prior']) {
        const records = [], missing = [];
        const req = { cortexApiKeyId: 'private-key-identifier', cortexUsageRequestId: 'request-one', path: '/v1/responses', body: {
            model: 'gpt-6-astra', previous_response_id: previousResponse,
            input: [{ type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(1_000_000) }], stream: true,
        } };
        const res = response();
        await createWeeklyCostMiddleware({ admit: async () => ({}), record: async (_req, usage) => records.push(usage) }, {
            onMissingUsage: event => missing.push(event),
        })(req, res, () => {});
        req.weeklyCostUpstreamStarted = true;
        res.write('event: response.output_text.delta\ndata: ' + JSON.stringify({ delta: 'x', metadata: 'x'.repeat(3_000_000) }) + '\n\n');
        res.emit('close'); res.end();
        t.is(records.length, 0);
        t.is(missing.length, 1);
        t.is(missing[0].request_id, 'request-one');
        t.false(JSON.stringify(missing).includes('private-key-identifier'));
        t.falsy(req.weeklyCostRecorded, 'missing usage must not suppress a later real report');
        t.false(JSON.stringify(missing).includes('data:image'));
    }
});

for (const eventType of ['response.completed', 'response.incomplete', 'response.done', 'response.failed', 'response.cancelled']) {
    test.serial(`Responses passthrough records ${eventType} usage once with cache discounts`, async t => {
        const adapter = axios.defaults.adapter, record = weeklyCostLimits.record, log = tokenUsageStore.log;
        const records = [], events = [], missing = [];
        const modelName = 'weekly-reported-test';
        const upstream = new PassThrough();
        const handlers = {};
        modelEndpoints[modelName] = { type: 'OPENAI-RESPONSES', name: modelName,
            endpoints: [{ url: 'https://provider.invalid/responses', limiter: { schedule: (_options, task) => task() } }],
        };
        weeklyCostLimits.record = async (req, usage) => { if (req.weeklyCostRecorded) return; req.weeklyCostRecorded = true; records.push(usage); };
        tokenUsageStore.log = event => events.push(event);
        axios.defaults.adapter = async () => ({ status: 200, data: upstream, headers: {} });
        t.teardown(() => { axios.defaults.adapter = adapter; weeklyCostLimits.record = record; tokenUsageStore.log = log; delete modelEndpoints[modelName]; upstream.destroy(); });
        registerOpenAIResponsesRoute({ post: (path, handler) => { handlers[path] = handler; } }, { route: { model: modelName } }, { [modelName]: 'route' }, {}, {});
        const req = Object.assign(new EventEmitter(), { cortexApiKeyId: 'key', path: '/v1/responses', body: { model: modelName, input: 'hello', stream: true } });
        const res = response();
        await createWeeklyCostMiddleware({ admit: async () => ({}), record: async (_req, usage) => records.push(usage) }, { onMissingUsage: event => missing.push(event) })(req, res, () => {});
        await handlers['/v1/responses'](req, res);
        const terminal = { type: eventType, response: { model: 'gpt-6-astra', status: eventType.slice(9),
            usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 900 }, output_tokens: 7, total_tokens: 1007 },
        } };
        const frame = `event: ${eventType}\ndata: ${JSON.stringify(terminal)}\n\n`;
        const finished = once(res, 'finish');
        // Fragmenting the frame also exercises the real SSE parser.
        upstream.write(frame.slice(0, 37)); upstream.write(frame.slice(37)); upstream.end(frame);
        await finished; res.emit('close');
        t.is(records.length, 1); t.is(events.length, 1); t.is(missing.length, 0);
        t.is(records[0].input_tokens, 100); t.is(records[0].cache_read_input_tokens, 900); t.is(records[0].output_tokens, 7);
        t.false(Boolean(records[0].cost_usage_estimated));
        t.true(res.chunks.join('').includes(JSON.stringify(terminal)), 'forward provider status and payload unchanged');
    });
}
