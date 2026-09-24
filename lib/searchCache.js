import { createHash, randomUUID } from 'node:crypto';

const stable = value => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
        .filter(key => value[key] !== undefined).map(key => [key, stable(value[key])]));
    return value;
};
const credential = /^(key|api[_-]?key|x-subscription-token|authorization|proxy-authorization)$/i;
const headersObject = headers => Object.fromEntries(Object.entries(headers || {})
    .map(([key, value]) => [key.toLowerCase(), String(value)]));

// Use the effective HTTP request, not the conversation or a guessed semantic query.
// Keep quoted text, punctuation, case, language and every filter intact.
export const searchCacheKey = ({ provider, url, params, headers }, namespace = 'cortex:search:v1') => {
    const parsed = new URL(url);
    const query = [...parsed.searchParams].filter(([key]) => !credential.test(key));
    parsed.search = '';
    parsed.username = '';
    parsed.password = '';
    const identity = {
        provider, url: parsed.toString(), query,
        params: Object.fromEntries(Object.entries(params || {}).filter(([key]) => !credential.test(key))),
        headers: Object.fromEntries(Object.entries(headersObject(headers)).filter(([key]) => !credential.test(key))),
    };
    // Data and lock share a Redis Cluster hash slot.
    return `${namespace}:{${createHash('sha256').update(JSON.stringify(stable(identity))).digest('hex')}}`;
};

export const searchCachePolicy = ({ provider, response, ttlMs, braveStorageAllowed = false, now = Date.now() }) => {
    const deny = reason => ({ ttlMs: 0, reason });
    if (response?.status !== 200 || !response.data || typeof response.data !== 'object'
        || response.data.error || (Array.isArray(response.data) && response.data[0]?.error)) return deny('unsuccessful_response');
    const headers = headersObject(response.headers);
    const directives = new Map((headers['cache-control'] || '').split(',').map(part => {
        const [key, ...value] = part.trim().toLowerCase().split('=');
        return [key, value.join('=').replace(/^"|"$/g, '')];
    }));
    if (['no-store', 'no-cache', 'private'].some(key => directives.has(key))) return deny('provider_cache_control');
    const vary = (headers.vary || '').toLowerCase().split(',').map(value => value.trim());
    if (vary.some(key => key === '*' || credential.test(key) || key === 'cookie') || headers['set-cookie']) return deny('private_response');
    if (provider === 'brave' && !braveStorageAllowed) return deny('storage_rights_required');
    if (!['brave', 'google_cse'].includes(provider)) return deny('unsupported_provider');

    // Missing freshness headers use the configured short application lifetime.
    // Explicit provider limits below can shorten or prohibit retention.
    let allowedMs = ttlMs;
    const maxAge = directives.get('s-maxage') ?? directives.get('max-age');
    const date = Date.parse(headers.date);
    const ageMs = Math.max(Number(headers.age || 0) * 1000, Number.isFinite(date) ? Math.max(0, now - date) : 0);
    if (!Number.isFinite(ageMs)) return deny('invalid_age');
    if (maxAge !== undefined) {
        if (!/^\d+$/.test(maxAge)) return deny('invalid_max_age');
        allowedMs = Math.min(allowedMs, Number(maxAge) * 1000 - ageMs);
    } else if (headers.expires) {
        const expires = Date.parse(headers.expires);
        if (!Number.isFinite(expires)) return deny('invalid_expiry');
        allowedMs = Math.min(allowedMs, expires - (Number.isFinite(date) ? date : now) - ageMs);
    }
    return Number.isFinite(allowedMs) && allowedMs > 0
        ? { ttlMs: Math.floor(allowedMs), reason: 'allowed' } : deny('expired_response');
};

const RELEASE = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';
const RENEW = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end';
// A slow owner whose lease expired cannot overwrite a newer result.
const PUBLISH = 'if redis.call("get", KEYS[1]) == ARGV[1] then redis.call("set", KEYS[2], ARGV[2], "PX", ARGV[3]); redis.call("del", KEYS[1]); return 1 else return 0 end';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class RedisSearchCache {
    constructor({ redis, namespace = 'cortex:search:v1', ttlMs = 300_000, braveStorageAllowed = false,
        operationTimeoutMs = 250, waitTimeoutMs = 10_000, leaseMs = 15_000, pollMs = 40,
        maxEntryBytes = 1_000_000, now = Date.now, onEvent = () => {}, serialize = JSON.stringify, deserialize = JSON.parse }) {
        Object.assign(this, { redis, namespace, ttlMs, braveStorageAllowed, operationTimeoutMs,
            waitTimeoutMs, leaseMs, pollMs, maxEntryBytes, now, onEvent, serialize, deserialize });
    }

    event(outcome, details = {}) {
        // Instrumentation must never prevent a search.
        try { this.onEvent({ outcome, ...details }); } catch { /* optional observer */ }
    }

    async command(operation) {
        let timer;
        try {
            return await Promise.race([operation(), new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Search cache operation timed out')), this.operationTimeoutMs);
            })]);
        } finally { clearTimeout(timer); }
    }

    async read(key, startedAt, refresh, maxAgeMs) {
        const raw = await this.command(() => this.redis.get(key));
        if (!raw) return null;
        try {
            const entry = this.deserialize(raw);
            if (entry.version === 1 && typeof entry.bypassReason === 'string') return entry;
            if (entry.version !== 1 || !entry.data || typeof entry.data !== 'object'
                || entry.status !== 200 || !Number.isFinite(entry.storedAt) || !Number.isFinite(entry.expiresAt)
                || entry.expiresAt <= this.now() || entry.storedAt > this.now()
                || (refresh ? entry.storedAt <= startedAt : this.now() - entry.storedAt > maxAgeMs)) return null;
            return entry;
        } catch { return null; }
    }

    async run(request, load, { refresh = false, maxAgeMs = this.ttlMs, isCancelled = () => false } = {}) {
        const startedAt = this.now();
        refresh = refresh || maxAgeMs === 0;
        if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) maxAgeMs = this.ttlMs;
        const context = { provider: request.provider, requestId: request.requestId, rootRequestId: request.rootRequestId };
        const checkCancelled = () => {
            if (isCancelled()) throw Object.assign(new Error('Request cancelled'), { name: 'AbortError' });
        };
        checkCancelled();
        const bypass = async reason => {
            checkCancelled();
            this.event('bypass', { ...context, reason });
            const response = await load();
            return { ...response, searchCache: { outcome: 'bypass', reason, fetchedAt: new Date(this.now()).toISOString() } };
        };
        if (!this.redis) return bypass('redis_unconfigured');
        if (headersObject(request.headers).cookie) return bypass('private_request');
        if (request.provider === 'brave' && !this.braveStorageAllowed) return bypass('storage_rights_required');
        const key = searchCacheKey(request, this.namespace);
        const lockKey = `${key}:lock`;
        const token = randomUUID();
        let waited = false;
        try {
            while (true) {
                checkCancelled();
                const entry = await this.read(key, startedAt, refresh, maxAgeMs);
                checkCancelled();
                if (entry?.bypassReason) return bypass(entry.bypassReason);
                if (entry) {
                    const outcome = waited ? 'coalesced' : 'hit';
                    const ageMs = this.now() - entry.storedAt;
                    this.event(outcome, { ...context, ageMs });
                    return { data: entry.data, status: entry.status, duration: this.now() - startedAt, cached: true,
                        searchCache: { outcome, ageMs, fetchedAt: new Date(entry.storedAt).toISOString() } };
                }
                const acquired = await this.command(() => this.redis.set(lockKey, token, 'PX', this.leaseMs, 'NX'));
                if (acquired === 'OK') break;
                if (this.now() - startedAt >= this.waitTimeoutMs) return bypass('wait_timeout');
                waited = true;
                await sleep(this.pollMs);
            }
            // Close the read/acquire race: an earlier owner may have just published.
            const entry = await this.read(key, startedAt, refresh, maxAgeMs);
            checkCancelled();
            if (entry) {
                await this.command(() => this.redis.eval(RELEASE, 1, lockKey, token));
                if (entry.bypassReason) return bypass(entry.bypassReason);
                const ageMs = this.now() - entry.storedAt;
                this.event('coalesced', { ...context, ageMs });
                return { data: entry.data, status: entry.status, duration: this.now() - startedAt, cached: true,
                    searchCache: { outcome: 'coalesced', ageMs, fetchedAt: new Date(entry.storedAt).toISOString() } };
            }
        } catch (error) {
            // An acquisition may have succeeded before a timeout; release only our token.
            this.command(() => this.redis.eval(RELEASE, 1, lockKey, token)).catch(() => {});
            if (error.name === 'AbortError') throw error;
            return bypass('redis_unavailable');
        }

        let renewing = false;
        const renew = setInterval(async () => {
            if (renewing) return;
            renewing = true;
            try { await this.command(() => this.redis.eval(RENEW, 1, lockKey, token, this.leaseMs)); }
            catch { /* fenced publish will reject a lost lease */ }
            finally { renewing = false; }
        }, Math.max(10, Math.floor(this.leaseMs / 3)));
        renew.unref?.();
        try {
            // Keep provider failures outside cache-error handling: never repeat a failed load here.
            checkCancelled();
            const response = await load();
            const storedAt = this.now();
            const policy = searchCachePolicy({ provider: request.provider, response, ttlMs: this.ttlMs,
                braveStorageAllowed: this.braveStorageAllowed, now: storedAt });
            let reason = policy.reason;
            let stored = false;
            if (policy.ttlMs > 0) {
                try {
                    const encoded = this.serialize({ version: 1, data: response.data, status: response.status,
                        storedAt, expiresAt: storedAt + policy.ttlMs });
                    if (Buffer.byteLength(encoded) <= this.maxEntryBytes) {
                        stored = await this.command(() => this.redis.eval(PUBLISH, 2, lockKey, key, token, encoded, policy.ttlMs)) === 1;
                        if (!stored) reason = 'lease_lost';
                    } else reason = 'entry_too_large';
                } catch { reason = 'redis_write_failed'; }
            } else if (policy.reason !== 'unsuccessful_response') {
                // A policy marker contains no result content. It releases waiting callers
                // promptly instead of serializing uncachable requests behind the lease.
                try {
                    await this.command(() => this.redis.eval(PUBLISH, 2, lockKey, key, token,
                        this.serialize({ version: 1, bypassReason: policy.reason }), 1000));
                } catch { /* search already succeeded */ }
            }
            this.event('miss', { ...context, stored, reason });
            return { ...response, searchCache: { outcome: 'miss', stored, reason,
                fetchedAt: new Date(storedAt).toISOString(), ageMs: 0 } };
        } finally {
            clearInterval(renew);
            try { await this.command(() => this.redis.eval(RELEASE, 1, lockKey, token)); } catch { /* lease expires */ }
        }
    }
}
