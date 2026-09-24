// Isolated adapter process for cache trials. The parent supplies its environment.
import GoogleCsePlugin from '../../server/plugins/googleCsePlugin.js';
import BraveSearchPlugin from '../../server/plugins/braveSearchPlugin.js';
import { config } from '../../config.js';

process.on('message', async ({ id, provider = 'google_cse', queries, url, enabled }) => {
    try {
        if (typeof enabled === 'boolean') config.set('searchCacheEnabled', enabled);
        const results = await Promise.all(queries.map(async parameters => {
            const endpoint = { name: 'local-test', url, limiter: { schedule: async (_options, fn) => fn() } };
            const model = { name: `local-${provider}`, type: provider === 'brave' ? 'BRAVE-SEARCH' : 'GOOGLE-CSE',
                maxTokenLength: 200000, supportsStreaming: false, endpoints: [endpoint] };
            const pathway = { name: provider, timeout: 5, temperature: 0, prompt: '', enableDuplicateRequests: false };
            const plugin = new (provider === 'brave' ? BraveSearchPlugin : GoogleCsePlugin)(pathway, model);
            const request = { url, params: {}, headers: {}, data: [], model, pathway, selectedEndpoint: endpoint,
                executionPolicy: { maxAttempts: 1, retryStatuses: [], allowDuplicateRequests: false },
                requestId: `local-${process.pid}-${id}-${Math.random()}`, initRequest() {} };
            const started = performance.now();
            const result = JSON.parse(await plugin.execute(parameters.q, parameters, {}, request));
            return { result, elapsedMs: performance.now() - started };
        }));
        process.send({ id, results });
    } catch (error) { process.send({ id, error: error.message }); }
});
process.send({ ready: true });
