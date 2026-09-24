import test from 'ava';
import Redis from 'ioredis';
import { spawn, fork } from 'node:child_process';
import { mkdtemp, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { RedisSearchCache, searchCacheKey } from '../../lib/searchCache.js';

// Explicit opt-in: starts its own disposable Redis and loopback-only provider.
const localTest = process.env.CORTEX_TEST_LOCAL_REDIS === '1' ? test.serial : test.skip;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let directory, socket, server, redisProcess, redis, url;
const workers = [];
const counts = new Map();
const request = (q = randomUUID()) => ({ provider: 'google_cse', url: 'https://provider.example/search', params: { q, cx: 'one' } });
const response = () => ({ status: 200, headers: { 'cache-control': 'public, max-age=60' }, data: { items: [{ title: 'Fresh source' }] } });
const cache = options => new RedisSearchCache({ redis, namespace: `test:${randomUUID()}`, pollMs: 10, ...options });

test.before(async () => {
    if (process.env.CORTEX_TEST_LOCAL_REDIS !== '1') return;
    directory = await mkdtemp(join(tmpdir(), 'cortex-search-cache-'));
    socket = join(directory, 'redis.sock');
    redisProcess = spawn('redis-server', ['--port', '0', '--unixsocket', socket, '--unixsocketperm', '700',
        '--save', '', '--appendonly', 'no', '--maxmemory', '32mb', '--maxmemory-policy', 'allkeys-lru'], { stdio: 'ignore' });
    const deadline = Date.now() + 5000;
    while (true) {
        try { await access(socket); break; } catch { if (Date.now() > deadline) throw new Error('Local Redis did not start'); }
        await sleep(20);
    }
    redis = new Redis({ path: socket, lazyConnect: true, retryStrategy: null, commandTimeout: 500 });
    await redis.connect();
    server = createServer(async (req, res) => {
        const query = new URL(req.url, 'http://localhost').searchParams;
        const q = query.get('q');
        const count = (counts.get(q) || 0) + 1;
        counts.set(q, count);
        await sleep(80);
        if (q !== 'no-cache-lifetime') res.setHeader('Cache-Control', 'public, max-age=60');
        if (q === 'explicit-no-store') res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Vary', 'X-Origin');
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ items: [{ title: q, link: 'https://example.org/article', snippet: `revision ${count}` }],
            web: { results: [{ title: q, url: 'https://example.org/article', description: `revision ${count}` }] } }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${server.address().port}/search`;
    for (let i = 0; i < 3; i++) {
        const child = fork(fileURLToPath(new URL('../fixtures/searchCacheWorker.mjs', import.meta.url)), [], {
            // Never inherit configured production connections or credentials.
            env: { PATH: process.env.PATH, NODE_ENV: 'test', OPENAI_API_KEY: 'test-only',
                GOOGLE_CSE_KEY: 'local-synthetic-key', GOOGLE_CSE_CX: 'local-engine', BRAVE_SEARCH_API_KEY: 'local-synthetic-key',
                STORAGE_CONNECTION_STRING: '', CORTEX_SEARCH_CACHE_ENABLED: 'true',
                CORTEX_SEARCH_CACHE_REDIS_URL: socket, CORTEX_SEARCH_CACHE_NAMESPACE: 'local-adapter-trial',
                REDIS_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef',
                CORTEX_SEARCH_CACHE_BRAVE_STORAGE_ALLOWED: 'true' },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        workers.push(child);
        let errorOutput = '';
        child.stdout.on('data', () => {});
        child.stderr.on('data', value => { errorOutput = (errorOutput + value).slice(-2000); });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Worker startup timeout: ${errorOutput}`)), 15_000);
            child.once('message', message => { clearTimeout(timer); message.ready ? resolve() : reject(new Error('Worker not ready')); });
            child.once('exit', code => { clearTimeout(timer); reject(new Error(`Worker exited ${code}: ${errorOutput}`)); });
        });
    }
});

test.after.always(async () => {
    for (const child of workers) child.kill();
    if (server) await new Promise(resolve => server.close(resolve));
    redis?.disconnect();
    if (redisProcess && redisProcess.exitCode === null) {
        const exited = once(redisProcess, 'exit');
        redisProcess.kill('SIGTERM');
        await exited;
    }
    if (directory) await rm(directory, { recursive: true, force: true });
});

const runWorker = (child, queries, provider = 'google_cse', options = {}) => new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { child.off('message', listener); reject(new Error('Worker request timeout')); }, 20_000);
    const listener = message => {
        if (message.id !== id) return;
        clearTimeout(timer);
        child.off('message', listener);
        message.error ? reject(new Error(message.error)) : resolve(message.results);
    };
    child.on('message', listener);
    child.send({ id, queries, provider, url, ...options });
});

localTest('three adapter processes collapse 60 cold requests into one provider call, then serve warm hits', async t => {
    const q = 'shared-breaking-news';
    const results = (await Promise.all(workers.map(worker => runWorker(worker, Array.from({ length: 20 }, () => ({ q })))))).flat();
    t.is(counts.get(q), 1);
    t.true(results.every(({ result }) => result.items[0].snippet === 'revision 1'));
    t.is(results.filter(({ result }) => result._searchCache.outcome === 'miss').length, 1);
    const warm = (await Promise.all(workers.map(worker => runWorker(worker, Array.from({ length: 20 }, () => ({ q })))))).flat();
    t.is(counts.get(q), 1);
    t.true(warm.every(({ result }) => result._searchCache.outcome === 'hit'));
    const entries = await redis.keys('local-adapter-trial:*');
    t.is(entries.length, 1);
    const stored = await redis.get(entries[0]);
    t.false(stored.includes('shared-breaking-news'));
    t.false(stored.includes('local-synthetic-key'));
    t.false(stored.includes('revision 1'));
    const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
    t.log(JSON.stringify({ requests: 120, providerCalls: counts.get(q), coldMedianMs: median(results.map(x => x.elapsedMs)), warmMedianMs: median(warm.map(x => x.elapsedMs)) }));
});

localTest('refreshes coalesce across processes and language, engine and provider stay distinct', async t => {
    const q = 'shared-breaking-news';
    await sleep(2);
    const refreshed = (await Promise.all(workers.map(worker => runWorker(worker, [{ q, searchRefresh: true }])))).flat();
    t.is(counts.get(q), 2);
    t.true(refreshed.every(({ result }) => result.items[0].snippet === 'revision 2'));
    await runWorker(workers[0], [{ q, lr: 'lang_ar' }, { q, cx: 'other-engine' }]);
    await runWorker(workers[1], [{ q }], 'brave');
    t.is(counts.get(q), 5);
    const braveHit = await runWorker(workers[2], [{ q }], 'brave');
    t.is(braveHit[0].result._searchCache.outcome, 'hit');
    t.is(counts.get(q), 5);
});

localTest('Google without freshness headers is shared across processes using the application TTL', async t => {
    const q = 'no-cache-lifetime';
    const results = (await Promise.all(workers.map(worker => runWorker(worker, [{ q }])))).flat();
    t.is(counts.get(q), 1);
    t.true(results.every(({ result }) => result.items[0].snippet === 'revision 1'));
    t.is(results.filter(({ result }) => result._searchCache.stored === true).length, 1);
    const warm = (await Promise.all(workers.map(worker => runWorker(worker, [{ q }])))).flat();
    t.is(counts.get(q), 1);
    t.true(warm.every(({ result }) => result._searchCache.outcome === 'hit'));
});

localTest('explicit no-store remains uncached and waiting requests are released promptly', async t => {
    const q = 'explicit-no-store';
    const results = (await Promise.all(workers.map(worker => runWorker(worker, [{ q }])))).flat();
    t.is(counts.get(q), 3);
    t.true(results.every(({ result }) => result._searchCache.reason === 'provider_cache_control'));
    t.true(results.every(x => x.elapsedMs < 2000));
});

localTest('expiry and per-call maximum age fetch new evidence without changing query identity', async t => {
    const c = cache({ ttlMs: 180 });
    const r = request();
    let calls = 0;
    const load = async () => { calls++; return response(); };
    await c.run(r, load);
    t.is((await c.run(r, load)).searchCache.outcome, 'hit');
    await sleep(35);
    await c.run(r, load, { maxAgeMs: 10 });
    t.is(calls, 2);
    await sleep(210);
    await c.run(r, load);
    t.is(calls, 3);
});

localTest('expired owner cannot overwrite a newer result; renewable leases protect slow searches', async t => {
    const c = cache({ leaseMs: 90 });
    const r = request();
    let calls = 0;
    const load = async () => { calls++; await sleep(240); return response(); };
    await Promise.all([c.run(r, load), c.run(r, load)]);
    t.is(calls, 1);

    const r2 = request();
    let release;
    const pending = c.run(r2, async () => { await new Promise(resolve => { release = resolve; }); return response(); });
    while (!release) await sleep(5);
    const key = searchCacheKey(r2, c.namespace);
    await redis.set(`${key}:lock`, 'new-owner', 'PX', 1000);
    const newer = JSON.stringify({ version: 1, status: 200, data: { items: ['newer'] }, storedAt: Date.now(), expiresAt: Date.now() + 1000 });
    await redis.set(key, newer, 'PX', 1000);
    release();
    t.is((await pending).searchCache.reason, 'lease_lost');
    t.is(await redis.get(key), newer);
    t.is(await redis.get(`${key}:lock`), 'new-owner');
});

localTest('a dead owner recovers after lease expiry; a persistent lock has a bounded wait', async t => {
    const c = cache({ waitTimeoutMs: 100, leaseMs: 60 });
    const r = request();
    await redis.set(`${searchCacheKey(r, c.namespace)}:lock`, 'dead-worker', 'PX', 50);
    t.is((await c.run(r, async () => response())).searchCache.outcome, 'miss');
    const r2 = request();
    await redis.set(`${searchCacheKey(r2, c.namespace)}:lock`, 'stuck-worker', 'PX', 1000);
    t.is((await c.run(r2, async () => response())).searchCache.reason, 'wait_timeout');
});

localTest('errors and oversized entries are not retained; corrupt entries recover', async t => {
    const c = cache({ maxEntryBytes: 400 });
    const r = request();
    await t.throwsAsync(c.run(r, async () => { throw new Error('upstream quota'); }), { message: 'upstream quota' });
    t.is(await redis.get(searchCacheKey(r, c.namespace)), null);
    const large = await c.run(r, async () => ({ ...response(), data: { text: 'x'.repeat(1000) } }));
    t.is(large.searchCache.reason, 'entry_too_large');
    t.is(await redis.get(searchCacheKey(r, c.namespace)), null);
    await redis.set(searchCacheKey(r, c.namespace), 'broken json', 'PX', 1000);
    t.true((await c.run(r, async () => response())).searchCache.stored);
});

localTest('a cancelled waiter stops without a provider call or disturbing the owner', async t => {
    const c = cache();
    const r = request();
    const lockKey = `${searchCacheKey(r, c.namespace)}:lock`;
    await redis.set(lockKey, 'another-worker', 'PX', 1000);
    let cancelled = false;
    let calls = 0;
    const waiting = c.run(r, async () => { calls++; return response(); }, { isCancelled: () => cancelled });
    await sleep(30);
    cancelled = true;
    await t.throwsAsync(waiting, { name: 'AbortError' });
    t.is(calls, 0);
    t.is(await redis.get(lockKey), 'another-worker');
});

localTest('feature disabled preserves the existing result shape and leaves shared Redis untouched', async t => {
    const before = (await redis.keys('local-adapter-trial:*')).sort();
    const results = await runWorker(workers[0], [{ q: 'feature-disabled' }], 'google_cse', { enabled: false });
    t.is(results[0].result._searchCache, undefined);
    t.deepEqual((await redis.keys('local-adapter-trial:*')).sort(), before);
});

localTest('real Redis shutdown falls through to the provider through the full adapter', async t => {
    const exited = once(redisProcess, 'exit');
    redisProcess.kill('SIGTERM');
    await exited;
    const results = await runWorker(workers[1], [{ q: 'redis-offline' }]);
    t.is(counts.get('redis-offline'), 1);
    t.is(results[0].result._searchCache.reason, 'redis_unavailable');
    t.true(results[0].elapsedMs < 1500);
});
