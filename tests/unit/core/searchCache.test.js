import test from 'ava';
import { RedisSearchCache, searchCacheKey, searchCachePolicy } from '../../../lib/searchCache.js';

const request = { provider: 'google_cse', url: 'https://example.com/search',
    params: { q: '"Gaza ceasefire"', cx: 'engine-1', num: 10, lr: 'lang_en', key: 'secret' } };
const response = (headers = {}) => ({ status: 200, data: { items: [{ link: 'https://example.org' }] }, headers });
const policy = (headers, extra = {}) => searchCachePolicy({ provider: 'google_cse', response: response(headers), ttlMs: 300_000, ...extra });

test('global identity ignores credentials and object order, but preserves all search semantics', t => {
    const key = searchCacheKey(request);
    t.false(key.includes('secret'));
    t.false(key.includes('Gaza'));
    t.is(key, searchCacheKey({ ...request, params: { key: 'rotated', lr: 'lang_en', num: 10, cx: 'engine-1', q: '"Gaza ceasefire"' } }));
    for (const change of [{ lr: 'lang_ar' }, { num: 5 }, { start: 11 }, { cx: 'engine-2' },
        { q: 'Gaza ceasefire' }, { dateRestrict: 'd1' }, { gl: 'qa' }, { siteSearch: 'example.com' }]) {
        t.not(key, searchCacheKey({ ...request, params: { ...request.params, ...change } }));
    }
    t.not(key, searchCacheKey({ ...request, provider: 'brave' }));
    t.not(key, searchCacheKey(request, 'development'));
    t.not(key, searchCacheKey({ ...request, headers: { 'X-Origin': 'different' } }));
});

test('Google uses the configured TTL without freshness headers; explicit restrictions win', t => {
    t.is(policy({}).ttlMs, 300_000);
    t.is(policy({ Vary: 'X-Origin' }).ttlMs, 300_000);
    t.is(policy({}, { ttlMs: 60_000 }).ttlMs, 60_000);
    for (const value of ['private, max-age=60', 'no-store, max-age=60', 'no-cache', 'max-age=0']) {
        t.is(policy({ 'cache-control': value }).ttlMs, 0);
    }
    t.is(policy({ 'Cache-Control': 'public, max-age=60', Age: '12' }).ttlMs, 48_000);
    t.is(policy({ 'cache-control': 'max-age=3600, s-maxage="30"' }).ttlMs, 30_000);
    t.is(policy({ 'cache-control': 'max-age=broken' }).ttlMs, 0);
    t.is(policy({ 'cache-control': 'max-age=60', vary: '*' }).ttlMs, 0);
    t.is(policy({ 'cache-control': 'max-age=60', vary: 'Authorization' }).ttlMs, 0);
    t.is(policy({ 'cache-control': 'max-age=60', 'set-cookie': 'private' }).ttlMs, 0);
});

test('expiry accounts for origin age and never extends the configured lifetime', t => {
    const now = Date.parse('2026-09-22T06:00:00Z');
    t.is(policy({ date: 'Tue, 22 Sep 2026 05:59:20 GMT', 'cache-control': 'max-age=60' }, { now }).ttlMs, 20_000);
    t.is(policy({ date: 'Tue, 22 Sep 2026 05:59:20 GMT', expires: 'Tue, 22 Sep 2026 06:00:30 GMT' }, { now }).ttlMs, 30_000);
    t.is(policy({ 'cache-control': 'max-age=86400' }).ttlMs, 300_000);
});

test('Brave storage permission is explicit and errors are never stored', t => {
    t.is(policy({}, { provider: 'brave' }).reason, 'storage_rights_required');
    t.is(policy({}, { provider: 'brave', braveStorageAllowed: true }).ttlMs, 300_000);
    for (const data of [{ error: 'quota' }, [{ error: 'failure' }], null]) {
        t.is(policy({}, { provider: 'brave', braveStorageAllowed: true, response: { status: 200, data } }).ttlMs, 0);
    }
    t.is(policy({}, { response: { status: 429, data: {} } }).ttlMs, 0);
});

test('Redis outages have a bounded cost and do not retry the provider load', async t => {
    let calls = 0;
    const redis = { get: () => new Promise(() => {}), eval: () => Promise.resolve(0) };
    const cache = new RedisSearchCache({ redis, operationTimeoutMs: 20 });
    const started = Date.now();
    const result = await cache.run(request, async () => { calls++; return response(); });
    t.is(calls, 1);
    t.is(result.searchCache.reason, 'redis_unavailable');
    t.true(Date.now() - started < 500);
    await t.throwsAsync(cache.run(request, async () => { calls++; throw new Error('provider failed'); }), { message: 'provider failed' });
    t.is(calls, 2);
});

test('private requests and missing Brave storage permission bypass Redis entirely', async t => {
    const cache = new RedisSearchCache({ redis: { get: () => { throw new Error('must not read'); } } });
    t.is((await cache.run({ ...request, headers: { Cookie: 'session=private' } }, async () => response())).searchCache.reason, 'private_request');
    t.is((await cache.run({ ...request, provider: 'brave' }, async () => response())).searchCache.reason, 'storage_rights_required');
});
