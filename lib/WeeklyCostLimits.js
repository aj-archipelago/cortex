import { MongoClient } from 'mongodb';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';

export const POLICY_TTL_MS = 60_000;
export const SNAPSHOT_INTERVAL_MS = 60_000;
export const DEFAULT_ADMISSION_TIMEOUT_MS = 100;
const MAX_TRACKED_KEYS = 10_000;
const RETENTION_MS = 90 * 86_400_000;

// Keys are scoped to the database, so shared Redis cannot mix environments.
export function budgetRedisPrefix(uri) {
    const url = new URL(uri);
    return `cortex:weekly-cost:v2:${createHash('sha256').update(url.host + url.pathname).digest('hex').slice(0, 16)}:`;
}

const SEED_COUNTER = `
if redis.call('EXISTS', KEYS[1]) == 0 then
    redis.call('HSET', KEYS[1], 'spentMicros', ARGV[1], 'requests', ARGV[2], 'fallbackRequests', ARGV[3])
    redis.call('PEXPIREAT', KEYS[1], ARGV[4])
end
return redis.call('HGET', KEYS[1], 'spentMicros')
`;

const ADD_COST = `
if redis.call('EXISTS', KEYS[1]) == 0 then return -1 end
local spent = redis.call('HINCRBY', KEYS[1], 'spentMicros', ARGV[1])
redis.call('HINCRBY', KEYS[1], 'requests', 1)
redis.call('HINCRBY', KEYS[1], 'fallbackRequests', ARGV[2])
return spent
`;

export const DEFAULT_WEEKLY_USD = null;
export function getDefaultWeeklyUsd(value = process.env.CORTEX_DEFAULT_WEEKLY_COST_USD) {
    if (value == null || String(value).trim() === '' || String(value).trim().toLowerCase() === 'unlimited') return DEFAULT_WEEKLY_USD;
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) throw new Error('CORTEX_DEFAULT_WEEKLY_COST_USD must be a nonnegative number or unlimited');
    return amount;
}
export const WEEK_MS = 7 * 86_400_000;
export const LIMITS_COLLECTION = 'api_key_cost_limits';
export const USAGE_COLLECTION = 'api_key_cost_periods';

export function budgetPeriod(anchor, now = new Date()) {
    const start = new Date(+new Date(anchor) + Math.max(0, Math.floor((+now - +new Date(anchor)) / WEEK_MS)) * WEEK_MS);
    return { start, end: new Date(+start + WEEK_MS) };
}

export function modelPricing(modelName, models) {
    const rates = { input: 5, output: 30, cacheWrite: 6.25, cacheRead: 0.5 };
    let match, snapshotMatch;
    // Providers may return a dated OpenAI model name while the catalog lists
    // its base name. Exact configured prices always win over this alias.
    const baseModel = typeof modelName === 'string'
        ? modelName.match(/^(gpt-[a-z\d.-]+|o\d[a-z\d.-]*)-\d{4}-\d{2}-\d{2}$/i)?.[1] : null;
    for (const [id, model] of Object.entries(models || {})) {
        const pricing = model.metadata?.pricing;
        if (!pricing) continue;
        for (const field of Object.keys(rates)) rates[field] = Math.max(rates[field], Number(pricing[field]) || 0);
        const aliases = [id, model.emulateOpenAIChatModel, model.emulateOpenAICompletionModel, model.params?.model, ...(model.endpoints || []).map(endpoint => endpoint.params?.model)];
        if (aliases.includes(modelName)) match = pricing;
        if (baseModel && aliases.includes(baseModel)) snapshotMatch = pricing;
    }
    match ||= snapshotMatch;
    const missingRates = Object.keys(rates).filter(field => !Number.isFinite(match?.[field]) || match[field] < 0);
    for (const field of Object.keys(rates)) if (!missingRates.includes(field)) rates[field] = match[field];
    return { rates, fallback: !match, missingRates };
}

export function estimateCostMicros(usage, pricing) {
    const fields = { input_tokens: 'input', output_tokens: 'output', cache_creation_input_tokens: 'cacheWrite', cache_read_input_tokens: 'cacheRead' };
    return Math.ceil(Object.entries(fields).reduce((sum, [field, rate]) => sum + Math.max(0, Number(usage[field]) || 0) * Math.max(0, Number(pricing[rate]) || 0), 0));
}

export class WeeklyCostLimits {
    constructor({
        defaultWeeklyUsd = getDefaultWeeklyUsd(),
        getUri = () => process.env.MONGO_URI,
        getRedisUri = () => process.env.COST_LIMIT_REDIS_URL || process.env.STORAGE_CONNECTION_STRING,
        getModels = () => ({}),
        createClient = uri => new MongoClient(uri, { maxPoolSize: 2, serverSelectionTimeoutMS: 2000, waitQueueTimeoutMS: 2000, timeoutMS: 2000 }),
        createRedis = uri => new Redis(uri, {
            commandTimeout: 500, connectTimeout: 1000, maxRetriesPerRequest: 0, lazyConnect: true,
            enableOfflineQueue: false, autoResendUnfulfilledCommands: false,
            retryStrategy: attempt => Math.min(attempt * 250, 5000),
        }),
        now = () => new Date(), onError = () => {}, autoFlush = true,
        sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
        admissionTimeoutMs = Number(process.env.COST_LIMIT_ADMISSION_TIMEOUT_MS || DEFAULT_ADMISSION_TIMEOUT_MS),
    } = {}) {
        Object.assign(this, { defaultWeeklyUsd, getUri, getRedisUri, getModels, createClient, createRedis, now, onError, autoFlush, sleep });
        this.admissionTimeoutMs = Number.isFinite(admissionTimeoutMs) && admissionTimeoutMs > 0 && admissionTimeoutMs <= 5000
            ? admissionTimeoutMs : DEFAULT_ADMISSION_TIMEOUT_MS;
        this.connection = null;
        this.policies = new Map();
        this.loadingPolicies = new Map();
        this.seeding = new Map();
        this.localSpend = new Map();
        this.dirty = new Map();
        this.retryAt = 0;
        this.lastWarning = -Infinity;
    }

    prefix() { return process.env.COST_LIMIT_REDIS_PREFIX || budgetRedisPrefix(this.getUri()); }
    counterKey(periodId) { return `${this.prefix()}period:${periodId}`; }

    remember(map, key, value) {
        map.delete(key);
        map.set(key, value);
        if (map.size > MAX_TRACKED_KEYS) map.delete(map.keys().next().value);
    }

    degraded(error) {
        this.retryAt = +this.now() + 5000;
        if (+this.now() - this.lastWarning >= 30_000) {
            this.lastWarning = +this.now();
            this.onError(error);
        }
    }

    redis() {
        if (!this.redisClient) {
            if (!this.getRedisUri()) throw Object.assign(new Error('Budget Redis is not configured'), { code: 'BUDGET_REDIS_NOT_CONFIGURED' });
            this.redisClient = this.createRedis(this.getRedisUri());
            this.redisClient.on('error', () => {}); // Commands report errors without logging connection secrets.
            if (this.autoFlush) {
                this.timer = setInterval(() => { this.flush().catch(error => this.onError(error)); }, SNAPSHOT_INTERVAL_MS);
                this.timer.unref();
            }
        }
        return this.redisClient;
    }

    async readyRedis() {
        const redis = this.redis();
        if (redis.status === 'wait' && !this.redisReady) this.redisReady = redis.connect().finally(() => { this.redisReady = null; });
        if (this.redisReady) await this.redisReady;
        if (redis.status && redis.status !== 'ready') throw Object.assign(new Error('Budget Redis is reconnecting'), { code: 'BUDGET_REDIS_RECONNECTING' });
        return redis;
    }

    async database() {
        if (!this.connection) {
            this.connection = (async () => {
                const client = this.createClient(this.getUri());
                try { await client.connect(); this.client = client; return client.db(); }
                catch (error) { await client.close(); throw error; }
            })().catch(error => { this.connection = null; throw error; });
        }
        return this.connection;
    }

    async policy(apiKeyId) {
        const cached = this.policies.get(apiKeyId);
        if (cached?.validUntil > +this.now()) return cached;
        if (this.loadingPolicies.has(apiKeyId)) return this.loadingPolicies.get(apiKeyId);
        const promise = (async () => {
            const redis = await this.readyRedis();
            const redisKey = `${this.prefix()}policy:${apiKeyId}`;
            const serialized = await redis.get(redisKey);
            let policy = serialized ? JSON.parse(serialized) : null;
            if (!policy || policy.validUntil <= +this.now()) {
                const db = await this.database();
                const policies = db.collection(LIMITS_COLLECTION);
                policy = await policies.findOne({ _id: apiKeyId });
                if (!policy) {
                    try {
                        await policies.updateOne({ _id: apiKeyId }, { $setOnInsert: { weeklyUsd: this.defaultWeeklyUsd, anchorAt: this.now(), createdAt: this.now() } }, { upsert: true });
                    } catch (error) { if (error.code !== 11000) throw error; }
                    policy = await policies.findOne({ _id: apiKeyId });
                }
                if (!policy.anchorAt) {
                    await policies.updateOne({ _id: apiKeyId, anchorAt: null }, { $set: { anchorAt: this.now() } });
                    policy = await policies.findOne({ _id: apiKeyId });
                }
                policy = { weeklyUsd: policy.weeklyUsd, anchorAt: policy.anchorAt, validUntil: +this.now() + POLICY_TTL_MS };
                await redis.set(redisKey, JSON.stringify(policy), 'PX', POLICY_TTL_MS);
            }
            if (policy.weeklyUsd !== null && (!Number.isFinite(policy.weeklyUsd) || policy.weeklyUsd < 0)) throw Object.assign(new Error('Invalid weekly cost limit'), { code: 'BUDGET_INVALID_LIMIT' });
            if (!Number.isFinite(+new Date(policy.anchorAt))) throw Object.assign(new Error('Invalid budget anchor'), { code: 'BUDGET_INVALID_ANCHOR' });
            this.remember(this.policies, apiKeyId, policy);
            return policy;
        })().finally(() => this.loadingPolicies.delete(apiKeyId));
        this.loadingPolicies.set(apiKeyId, promise);
        return promise;
    }

    async seed(budget) {
        if (this.seeding.has(budget.periodId)) return this.seeding.get(budget.periodId);
        const promise = (async () => {
            const db = await this.database();
            const saved = await db.collection(USAGE_COLLECTION).findOne({ _id: budget.periodId }, { projection: { spentMicros: 1, requests: 1, fallbackRequests: 1 } });
            return Number(await this.redis().eval(SEED_COUNTER, 1, this.counterKey(budget.periodId), saved?.spentMicros || 0, saved?.requests || 0, saved?.fallbackRequests || 0, +budget.end + RETENTION_MS));
        })().finally(() => this.seeding.delete(budget.periodId));
        this.seeding.set(budget.periodId, promise);
        return promise;
    }

    async sharedBudget(apiKeyId) {
        const policy = await this.policy(apiKeyId);
        const period = budgetPeriod(policy.anchorAt, this.now());
        const budget = { apiKeyId, periodId: `${apiKeyId}:${period.start.toISOString()}`, ...period, weeklyUsd: policy.weeklyUsd };
        const value = await this.redis().hget(this.counterKey(budget.periodId), 'spentMicros');
        budget.spentMicros = value === null ? await this.seed(budget) : Number(value);
        this.remember(this.localSpend, budget.periodId, budget.spentMicros);
        return budget;
    }

    async admit(apiKeyId) {
        if (!apiKeyId || apiKeyId === 'local' || !this.getUri()) return null;
        let policy = this.policies.get(apiKeyId);
        let budget;
        let deadline;
        try {
            if (this.retryAt > +this.now()) throw new Error('Budget Redis backoff');
            // Cold policy loads, refreshes and counter restores must not make
            // generation wait indefinitely. The coalesced load may finish in
            // the background; Mongo operations have their own bounded timeout.
            budget = await Promise.race([
                this.sharedBudget(apiKeyId),
                new Promise((_, reject) => {
                    deadline = setTimeout(() => reject(Object.assign(new Error('Budget admission deadline exceeded'), { code: 'BUDGET_ADMISSION_TIMEOUT' })), this.admissionTimeoutMs);
                }),
            ]);
        } catch (error) {
            // Availability wins over exact quota enforcement. Keep checking the
            // last local allowance during an outage; do not fall back to Mongo per request.
            if (this.retryAt <= +this.now()) this.degraded(error);
            policy = this.policies.get(apiKeyId) || policy;
            policy ||= { weeklyUsd: this.defaultWeeklyUsd, anchorAt: this.now(), validUntil: 0 };
            if (!this.policies.has(apiKeyId)) this.remember(this.policies, apiKeyId, policy);
            const period = budgetPeriod(policy.anchorAt, this.now());
            const periodId = `${apiKeyId}:${period.start.toISOString()}`;
            budget = { apiKeyId, periodId, ...period, weeklyUsd: policy.weeklyUsd, spentMicros: this.localSpend.get(periodId) || 0, degraded: true };
        } finally {
            clearTimeout(deadline);
        }
        if (budget.weeklyUsd != null && budget.spentMicros >= Math.round(budget.weeklyUsd * 1_000_000)) {
            const error = new Error('Weekly estimated cost limit reached');
            error.code = 'weekly_cost_limit_exceeded';
            error.budget = budget;
            throw error;
        }
        return budget;
    }

    async record(req, usage) {
        const budget = req.weeklyCostBudget;
        if (!budget || req.weeklyCostRecorded || usage.cost_usage_estimated) return;
        req.weeklyCostRecorded = true;
        const pricing = modelPricing(usage.model, this.getModels());
        const fields = { input_tokens: 'input', output_tokens: 'output', cache_creation_input_tokens: 'cacheWrite', cache_read_input_tokens: 'cacheRead' };
        pricing.fallback ||= Object.entries(fields).some(([field, rate]) => usage[field] > 0 && pricing.missingRates.includes(rate));
        const totalOnly = Object.keys(fields).every(field => usage[field] == null) && usage.total_tokens > 0;
        if (totalOnly) pricing.fallback = true;
        const spentMicros = totalOnly ? Math.ceil(usage.total_tokens * Math.max(...Object.values(pricing.rates))) : estimateCostMicros(usage, pricing.rates);
        usage.estimated_cost_usd = spentMicros / 1_000_000;
        usage.cost_pricing_fallback = pricing.fallback;
        this.remember(this.localSpend, budget.periodId, (this.localSpend.get(budget.periodId) || budget.spentMicros) + spentMicros);
        if (budget.degraded) return;
        this.remember(this.dirty, budget.periodId, { ...budget });
        try {
            const add = () => this.redis().eval(ADD_COST, 1, this.counterKey(budget.periodId), spentMicros, pricing.fallback || usage.cost_usage_estimated ? 1 : 0);
            let result = Number(await add());
            if (result === -1) { await this.seed(budget); result = Number(await add()); }
            if (result === -1) throw new Error('Budget counter repeatedly evicted');
            this.remember(this.localSpend, budget.periodId, Math.max(result, this.localSpend.get(budget.periodId) || 0));
        } catch (error) {
            // Do not retry an ambiguous INCR: it may already have applied. A lost
            // debit is acceptable for this approximate guard; generation continues.
            this.degraded(error);
        }
    }

    async flush() {
        if (this.flushing) return this.flushing;
        this.flushing = this.flushSnapshots().finally(() => { this.flushing = null; });
        return this.flushing;
    }

    async flushSnapshots() {
        const entries = [...this.dirty.values()].slice(0, 1000);
        if (!entries.length) return;
        const pipeline = this.redis().pipeline();
        for (const budget of entries) {
            const key = this.counterKey(budget.periodId);
            // One snapshot writer per active period, independent of replica count.
            pipeline.set(`${key}:snapshot-lock`, '1', 'PX', SNAPSHOT_INTERVAL_MS - 1000, 'NX');
            pipeline.hgetall(key);
        }
        const results = await pipeline.exec();
        const selected = [];
        const operations = [];
        entries.forEach((budget, i) => {
            const [lockError, lock] = results[i * 2];
            const [readError, value] = results[i * 2 + 1];
            if (lockError || readError) throw lockError || readError;
            if (lock !== 'OK' || !value?.spentMicros) return;
            selected.push(budget);
            operations.push({ updateOne: {
                filter: { _id: budget.periodId },
                update: {
                    $max: { spentMicros: Number(value.spentMicros), requests: Number(value.requests), fallbackRequests: Number(value.fallbackRequests) },
                    $set: { snapshotAt: this.now() },
                    $setOnInsert: { apiKeyId: budget.apiKeyId, periodStart: budget.start, resetAt: budget.end, expiresAt: new Date(+budget.end + RETENTION_MS) },
                }, upsert: true,
            } });
        });
        if (operations.length) {
            const db = await this.database();
            let pendingOperations = operations;
            for (let attempt = 0; ; attempt++) {
                try {
                    await db.collection(USAGE_COLLECTION).bulkWrite(pendingOperations, { ordered: false });
                    break;
                } catch (error) {
                    // Cosmos can throttle a synchronized snapshot burst even
                    // when its average RU load is low. These absolute $max
                    // writes are safe to retry after partial bulk success.
                    // Retry only throttling, off the request path; retain dirty
                    // entries for the next interval if the bounded retries fail.
                    if (error.code !== 16500 || attempt >= 4) throw error;
                    const failures = error.writeErrors;
                    if (Array.isArray(failures) && failures.length) {
                        if (failures.some(failure => failure.code !== 16500 || !Number.isInteger(failure.index) || !pendingOperations[failure.index])) throw error;
                        // Replaying successful upserts can spend the available
                        // RUs again and starve the same trailing operations.
                        pendingOperations = [...new Set(failures.map(failure => failure.index))].map(index => pendingOperations[index]);
                    }
                    const retryAfter = Number(/RetryAfterMs=(\d+)/i.exec(error.message || '')?.[1]) || 0;
                    const delay = Math.min(2000, Math.max(250 * 2 ** attempt, retryAfter));
                    await this.sleep(delay + Math.floor(Math.random() * 100));
                }
            }
            for (const budget of selected) if (this.dirty.get(budget.periodId) === budget) this.dirty.delete(budget.periodId);
        }
    }

    async close() {
        clearInterval(this.timer);
        try { await this.flush(); } finally {
            this.redisClient?.disconnect();
            if (this.client) await this.client.close();
            this.connection = null;
        }
    }
}
