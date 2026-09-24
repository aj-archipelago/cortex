import test from 'ava';
import { WeeklyCostLimits, budgetPeriod, estimateCostMicros, modelPricing, DEFAULT_WEEKLY_USD, getDefaultWeeklyUsd, POLICY_TTL_MS } from '../../../lib/WeeklyCostLimits.js';
const key = '000000000001';
function fixture(options = {}) {
    const tables = new Map(), strings = new Map(), hashes = new Map(), expires = new Map();
    let now = new Date('2026-09-08T12:00:00Z'), mongoDown = false, redisDown = false;
    let mongoCalls = 0, redisCalls = 0, ambiguous = false;
    let mongoReadGate;
    let snapshotErrors = [];
    const snapshotBatchSizes = [];
    const mongoCheck = () => { mongoCalls++; if (mongoDown) throw new Error('Mongo offline'); };
    const redisCheck = key => { redisCalls++; if (redisDown) throw new Error('Redis offline'); if (expires.has(key) && expires.get(key) <= +now) { strings.delete(key); hashes.delete(key); expires.delete(key); } };
    const db = { collection(name) {
        if (!tables.has(name)) tables.set(name, new Map());
        const docs = tables.get(name);
        const apply = (filter, update, options = {}) => {
            const previous = docs.get(filter._id);
            if (filter.anchorAt === null && previous?.anchorAt) return { matchedCount: 0 };
            if (!previous && !options.upsert) return { matchedCount: 0 };
            const doc = previous || { _id: filter._id, ...update.$setOnInsert };
            Object.assign(doc, update.$set);
            for (const [field, value] of Object.entries(update.$max || {})) doc[field] = Math.max(doc[field] || 0, value);
            docs.set(filter._id, doc); return { matchedCount: 1 };
        };
        return {
            async findOne(filter) { mongoCheck(); if (mongoReadGate) await mongoReadGate; return docs.get(filter._id) || null; },
            async updateOne(filter, update, options) { mongoCheck(); return apply(filter, update, options); },
            async bulkWrite(ops) {
                mongoCheck();
                snapshotBatchSizes.push(ops.length);
                for (const { updateOne: op } of ops) apply(op.filter, op.update, op);
                if (snapshotErrors.length) throw snapshotErrors.shift();
            },
        };
    } };
    const redis = {
        on() {}, disconnect() {},
        async get(k) { redisCheck(k); return strings.get(k) ?? null; },
        async set(k, value, ...args) {
            redisCheck(k);
            if (args.includes('NX') && strings.has(k)) return null;
            strings.set(k, value);
            if (args.includes('PX')) expires.set(k, +now + args[args.indexOf('PX') + 1]);
            return 'OK';
        },
        async hget(k, field) { redisCheck(k); return hashes.get(k)?.[field] ?? null; },
        async hgetall(k) { redisCheck(k); return { ...hashes.get(k) }; },
        async eval(script, count, k, ...args) {
            redisCheck(k);
            if (script.includes('HINCRBY')) {
                if (!hashes.has(k)) return -1;
                const hash = hashes.get(k);
                hash.spentMicros = String(Number(hash.spentMicros) + Number(args[0]));
                hash.requests = String(Number(hash.requests) + 1);
                hash.fallbackRequests = String(Number(hash.fallbackRequests) + Number(args[1]));
                if (ambiguous) { ambiguous = false; throw new Error('lost acknowledgment'); }
                return Number(hash.spentMicros);
            }
            if (!hashes.has(k)) hashes.set(k, { spentMicros: String(args[0]), requests: String(args[1]), fallbackRequests: String(args[2]) });
            return hashes.get(k).spentMicros;
        },
        pipeline() {
            const commands = [];
            const chain = { set(...args) { commands.push(() => redis.set(...args)); return chain; }, hgetall(...args) { commands.push(() => redis.hgetall(...args)); return chain; }, async exec() { return Promise.all(commands.map(async command => { try { return [null, await command()]; } catch (error) { return [error, null]; } })); } };
            return chain;
        },
    };
    const build = () => new WeeklyCostLimits({ defaultWeeklyUsd: 500,
        getUri: () => 'mongodb://test/budgets', getRedisUri: () => 'redis://test', createRedis: () => redis,
        getModels: () => ({ test: { emulateOpenAIChatModel: 'model', metadata: { pricing: { input: 5, output: 30, cacheRead: 0.5 } } } }),
        now: () => now, autoFlush: false,
        createClient: () => ({ connect: async () => {}, close: async () => {}, db: () => db }),
        ...options,
    });
    return { limits: build(), build, tables, hashes, strings, snapshotBatchSizes, snapshotErrors: errors => { snapshotErrors = errors; }, blockMongoReads: gate => { mongoReadGate = gate; }, advance: ms => { now = new Date(+now + ms); }, setNow: value => { now = new Date(value); }, mongoFail: value => { mongoDown = value; }, redisFail: value => { redisDown = value; }, ambiguous: () => { ambiguous = true; }, counts: () => ({ mongo: mongoCalls, redis: redisCalls }) };
}
const charge = async (limits, tokens = 1_000_000) => {
    const req = { weeklyCostBudget: await limits.admit(key) };
    await limits.record(req, { model: 'model', input_tokens: tokens }); return req;
};
test('configured default allowance anchors on first admission', async t => {
    const f = fixture(); const budget = await f.limits.admit(key);
    t.is(DEFAULT_WEEKLY_USD, null); t.is(budget.weeklyUsd, 500); t.is(budget.end.toISOString(), '2026-09-15T12:00:00.000Z');
});
test('steady requests do one Redis read and increment, with no Mongo access', async t => {
    const f = fixture(); await f.limits.admit(key); const before = f.counts();
    for (let i = 0; i < 20; i++) await charge(f.limits);
    t.is(f.counts().mongo, before.mongo); t.is(f.counts().redis - before.redis, 40);
    t.is((await f.limits.admit(key)).spentMicros, 100_000_000);
});
test('slow cold Mongo reads cannot hold requests beyond the admission deadline', async t => {
    const f = fixture({ admissionTimeoutMs: 20 });
    let release;
    f.blockMongoReads(new Promise(resolve => { release = resolve; }));
    let timer;
    try {
        const pending = Promise.all(Array.from({ length: 20 }, () => f.limits.admit(key)));
        const result = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve('blocked'), 500); })]);
        t.not(result, 'blocked');
        if (result === 'blocked') return;
        t.true(result.every(budget => budget.degraded && budget.weeklyUsd === 500));
        t.is(f.counts().mongo, 1);
        const loading = f.limits.loadingPolicies.get(key);
        release();
        await loading;
        f.advance(5000);
        t.falsy((await f.limits.admit(key)).degraded);
    } finally { clearTimeout(timer); release(); }
});
test('slow Redis still rejects a known exhausted local allowance', async t => {
    const f = fixture({ admissionTimeoutMs: 20 });
    const budget = await f.limits.admit(key);
    f.limits.localSpend.set(budget.periodId, 500_000_000);
    const redis = f.limits.redis();
    const hget = redis.hget;
    let release;
    redis.hget = () => new Promise(resolve => { release = resolve; });
    let timer;
    try {
        const result = await Promise.race([
            f.limits.admit(key).then(() => 'allowed', error => error.code),
            new Promise(resolve => { timer = setTimeout(() => resolve('blocked'), 500); }),
        ]);
        t.is(result, 'weekly_cost_limit_exceeded');
    } finally { clearTimeout(timer); redis.hget = hget; release?.('500000000'); }
});
test('uses cache prices, upstream aliases and conservative unknown rates', t => {
    const pricing = modelPricing('upstream', { foo: { endpoints: [{ params: { model: 'upstream' } }], metadata: { pricing: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 } } } });
    t.false(pricing.fallback);
    t.is(estimateCostMicros({ input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 }, pricing.rates), 41_750_000);
    t.true(modelPricing('unknown', {}).fallback);
});
test('dated provider models use base prices while exact snapshot prices win', t => {
    const models = {
        base: { emulateOpenAIChatModel: 'gpt-example', metadata: { pricing: { input: 2, output: 8, cacheRead: 0.2 } } },
        unrelated: { emulateOpenAIChatModel: 'gpt-other', metadata: { pricing: { input: 100, output: 500 } } },
    };
    const aliased = modelPricing('gpt-example-2026-09-24', models);
    t.false(aliased.fallback); t.is(aliased.rates.input, 2); t.is(aliased.rates.output, 8); t.is(aliased.rates.cacheRead, 0.2);
    models.snapshot = { params: { model: 'gpt-example-2026-09-24' }, metadata: { pricing: { input: 3, output: 9 } } };
    t.is(modelPricing('gpt-example-2026-09-24', models).rates.input, 3);
    t.true(modelPricing('unknown-2026-09-24', models).fallback);
});
test('synthetic usage does not consume allowance or suppress late provider usage', async t => {
    const f = fixture();
    const req = { weeklyCostBudget: await f.limits.admit(key) };
    await f.limits.record(req, { model: 'model', input_tokens: 1_000_000, output_tokens: 3_000_000, cost_usage_estimated: true });
    t.falsy(req.weeklyCostRecorded); t.is((await f.limits.admit(key)).spentMicros, 0);
    await f.limits.record(req, { model: 'model', input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 900 });
    await f.limits.record(req, { model: 'model', input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 900 });
    t.is((await f.limits.admit(key)).spentMicros, 1250);
});
test('charges callbacks once and rejects new requests at the cap', async t => {
    const f = fixture(); const req = await charge(f.limits, 100_000_000);
    await f.limits.record(req, { model: 'model', input_tokens: 100_000_000 });
    const error = await t.throwsAsync(() => f.limits.admit(key)); t.is(error.code, 'weekly_cost_limit_exceeded'); t.is(error.budget.spentMicros, 500_000_000);
});
test('different workers share Redis spend; snapshots are absolute and retry-safe', async t => {
    const f = fixture(); const workers = Array.from({ length: 20 }, () => f.build());
    await Promise.all(workers.map(worker => charge(worker)));
    t.is((await f.limits.admit(key)).spentMicros, 100_000_000);
    await Promise.all(workers.map(worker => worker.flush()));
    t.is([...f.tables.get('api_key_cost_periods').values()][0].spentMicros, 100_000_000);
    f.advance(60_000); await Promise.all(workers.map(worker => worker.flush()));
    t.is([...f.tables.get('api_key_cost_periods').values()][0].spentMicros, 100_000_000);
});
test('reset is automatic; late completion stays in its admitted week', async t => {
    const f = fixture(); const old = { weeklyCostBudget: await f.limits.admit(key) };
    f.setNow('2026-09-15T12:00:00Z'); const next = await f.limits.admit(key);
    t.is(next.spentMicros, 0); t.not(next.periodId, old.weeklyCostBudget.periodId);
    await f.limits.record(old, { model: 'model', input_tokens: 100_000_000 });
    t.is((await f.limits.admit(key)).spentMicros, 0);
    t.is(budgetPeriod(old.weeklyCostBudget.start, new Date('2026-09-29T12:00:00Z')).end.toISOString(), '2026-10-06T12:00:00.000Z');
});
test('policy edits propagate after TTL without resetting spend; unlimited and zero work', async t => {
    const f = fixture(); await charge(f.limits); const policy = f.tables.get('api_key_cost_limits').get(key);
    policy.weeklyUsd = 4; t.is((await f.limits.admit(key)).weeklyUsd, 500);
    f.advance(POLICY_TTL_MS); await t.throwsAsync(() => f.limits.admit(key), { code: 'weekly_cost_limit_exceeded' });
    policy.weeklyUsd = null; f.advance(POLICY_TTL_MS); t.is((await f.limits.admit(key)).spentMicros, 5_000_000);
    policy.weeklyUsd = 0; f.advance(POLICY_TTL_MS); await t.throwsAsync(() => f.limits.admit(key), { code: 'weekly_cost_limit_exceeded' });
});
test('warm traffic tolerates Mongo downtime; failed snapshots are retried later', async t => {
    const f = fixture(); await f.limits.admit(key); f.mongoFail(true);
    await charge(f.limits); await t.throwsAsync(() => f.limits.flush());
    t.is((await f.limits.admit(key)).spentMicros, 5_000_000);
    f.mongoFail(false); f.advance(60_000); await f.limits.flush();
    t.is([...f.tables.get('api_key_cost_periods').values()][0].spentMicros, 5_000_000);
});
test('Redis outage uses local allowance and backs off without querying Mongo', async t => {
    const f = fixture(); await charge(f.limits, 99_000_000); f.redisFail(true); const before = f.counts().mongo;
    const degraded = await charge(f.limits); t.true(degraded.weeklyCostBudget.degraded);
    await t.throwsAsync(() => f.limits.admit(key), { code: 'weekly_cost_limit_exceeded' }); t.is(f.counts().mongo, before);
    f.redisFail(false); f.advance(5000); t.is((await f.limits.admit(key)).spentMicros, 495_000_000);
});
test('throttled snapshots retry absolute totals without blocking warm admission', async t => {
    const delays = [];
    const f = fixture({ sleep: async delay => { delays.push(delay); t.is((await f.limits.admit(key)).spentMicros, 5_000_000); } });
    await charge(f.limits);
    f.snapshotErrors([Object.assign(new Error('RetryAfterMs=700'), { code: 16500 })]);
    await f.limits.flush();
    t.is(delays.length, 1); t.true(delays[0] >= 700 && delays[0] < 800);
    t.is([...f.tables.get('api_key_cost_periods').values()][0].spentMicros, 5_000_000);
    t.is(f.limits.dirty.size, 0);
});
test('persistent snapshot throttling is bounded and retains pending totals', async t => {
    const delays = [];
    const f = fixture({ sleep: async delay => { delays.push(delay); } });
    await charge(f.limits);
    f.snapshotErrors(Array.from({ length: 5 }, () => Object.assign(new Error('throttled'), { code: 16500 })));
    await t.throwsAsync(() => f.limits.flush(), { code: 16500 });
    t.is(delays.length, 4); t.is(f.limits.dirty.size, 1);
    f.advance(60_000); await f.limits.flush();
    t.is(f.limits.dirty.size, 0);
    t.is([...f.tables.get('api_key_cost_periods').values()][0].spentMicros, 5_000_000);
});
test('partial snapshot throttling retries only the failed upserts', async t => {
    const f = fixture({ sleep: async () => {} });
    await charge(f.limits);
    await f.limits.record({ weeklyCostBudget: await f.limits.admit('000000000002') }, { model: 'model', input_tokens: 1_000_000 });
    f.snapshotErrors([Object.assign(new Error('throttled'), { code: 16500, writeErrors: [{ index: 1, code: 16500 }] })]);
    await f.limits.flush();
    t.deepEqual(f.snapshotBatchSizes, [2, 1]);
    t.is(f.limits.dirty.size, 0);
    t.deepEqual([...f.tables.get('api_key_cost_periods').values()].map(row => row.spentMicros), [5_000_000, 5_000_000]);
});
test('Redis loss restores the last Mongo snapshot, without replaying absolute totals', async t => {
    const f = fixture(); await charge(f.limits); await f.limits.flush();
    f.hashes.clear(); f.strings.clear(); const fresh = f.build();
    t.is((await fresh.admit(key)).spentMicros, 5_000_000);
    await charge(fresh); f.advance(60_000); await fresh.flush();
    t.is([...f.tables.get('api_key_cost_periods').values()][0].spentMicros, 10_000_000);
});
test('ambiguous Redis increment is not retried and does not block generation', async t => {
    const f = fixture(); await f.limits.admit(key); f.ambiguous(); await charge(f.limits);
    f.advance(5000); t.is((await f.limits.admit(key)).spentMicros, 5_000_000);
});
test('missing bucket prices and total-only usage are not free', async t => {
    const f = fixture(); const usage = { model: 'model', cache_creation_input_tokens: 1_000_000 };
    await f.limits.record({ weeklyCostBudget: await f.limits.admit(key) }, usage);
    t.true(usage.cost_pricing_fallback); t.is(usage.estimated_cost_usd, 6.25);
    const legacy = { model: 'model', total_tokens: 1_000_000 };
    await f.limits.record({ weeklyCostBudget: await f.limits.admit(key) }, legacy);
    t.is(legacy.estimated_cost_usd, 30); t.true(legacy.cost_pricing_fallback);
});


test('operator default allowances accept unlimited and nonnegative amounts', t => {
    for (const value of [undefined, null, '', ' Unlimited ']) t.is(getDefaultWeeklyUsd(value), null);
    t.is(getDefaultWeeklyUsd('0'), 0);
    t.is(getDefaultWeeklyUsd('42.50'), 42.5);
    for (const value of ['-1', 'unknown', 'Infinity']) t.throws(() => getDefaultWeeklyUsd(value));
});
