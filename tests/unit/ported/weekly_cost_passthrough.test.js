import test from 'ava';
import { EventEmitter } from 'node:events';
import { createWeeklyCostMiddleware } from '../../../server/rest/weeklyCostMiddleware.js';

import { config } from '../../../config.js';
// Load route modules with local-only services and no shared Axios cache.
config.set('storageConnectionString', '');
config.set('enableCache', false);
const { axios, modelEndpoints } = await import('../../../lib/requestExecutor.js');
const { registerOpenAICompletionsRoute } = await import('../../../server/rest/openaiCompletionsRoute.js');
const { registerOpenAIResponsesRoute } = await import('../../../server/rest/openaiResponsesRoute.js');
const { registerAnthropicMessagesRoute } = await import('../../../server/rest/anthropicMessagesRoute.js');

for (const [route, type, register] of [
    ['/v1/chat/completions', 'OPENAI-CHAT', registerOpenAICompletionsRoute],
    ['/v1/responses', 'OPENAI-RESPONSES', registerOpenAIResponsesRoute],
    ['/v1/messages', 'CLAUDE-ANTHROPIC', registerAnthropicMessagesRoute],
]) {
    test.serial(`${route}: provider rejections reach settlement without a fallback charge`, async t => {
        const originalAdapter = axios.defaults.adapter;
        const modelName = 'weekly-budget-test';
        const handlers = {};
        modelEndpoints[modelName] = {
            type, name: modelName,
            endpoints: [{ url: 'https://provider.invalid/test', limiter: { schedule: (_options, task) => task() } }],
        };
        t.teardown(() => { axios.defaults.adapter = originalAdapter; delete modelEndpoints[modelName]; });
        register({ post: (path, handler) => { handlers[path] = handler; } }, { testPathway: { model: modelName } }, { [modelName]: 'testPathway' }, {}, {});
        for (const status of [400, 401, 429]) {
            for (const stream of [false, true]) {
                let upstreamCalls = 0;
                axios.defaults.adapter = async () => {
                    upstreamCalls++;
                    throw Object.assign(new Error('Provider rejected request'), { response: { status, data: { error: { message: 'Rejected' } } } });
                };
                const records = [];
                const req = { path: route, body: { model: modelName, input: 'hello', messages: [{ role: 'user', content: 'hello' }], previous_response_id: 'invalid-id', stream } };
                const res = Object.assign(new EventEmitter(), {
                    statusCode: 200, headersSent: false,
                    setHeader() {}, flushHeaders() { this.headersSent = true; },
                    status(code) { this.statusCode = code; return this; },
                    write() {}, end() { this.emit('finish'); },
                    json(body) { this.end(JSON.stringify(body)); return this; },
                });
                await createWeeklyCostMiddleware({ admit: async () => ({}), record: async (_req, usage) => { records.push(usage); } })(req, res, () => {});
                await handlers[route](req, res);
                res.emit('close');
                t.is(upstreamCalls, 1);
                t.true(req.weeklyCostUpstreamStarted);
                t.is(records.length, 0, `${status}, stream=${stream}`);
            }
        }
    });
}
