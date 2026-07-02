// lib/TokenUsageStore.js
// Buffered MongoDB writer for token_usage events.
// Fire-and-forget — never blocks or fails the calling request.

import { MongoClient } from 'mongodb';
import logger from './logger.js';

const COLLECTION_NAME = 'token_usage';
const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_BATCH_SIZE = 50;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const TTL_DAYS = 90;

const shouldEnsureRuntimeIndexes = () =>
    process.env.ENSURE_MONGO_INDEXES === 'true';

const parseRetryAfterMs = (err) => {
    if (!err) return null;

    for (const key of ['retryAfterMS', 'retryAfterMs', 'retryAfter']) {
        const value = err[key];
        if (Number.isFinite(value)) return Number(value);
    }

    const message = String(err.message || '');
    const match = message.match(/RetryAfterMs=(\d+)/i);
    if (match) return Number(match[1]);

    return null;
};

const calculateRetryDelayMs = (err, attempt, { baseMs = RETRY_BASE_MS, maxMs = RETRY_MAX_MS } = {}) => {
    const retryAfterMs = parseRetryAfterMs(err);
    const exponentialDelayMs = Math.min(maxMs, baseMs * (2 ** Math.max(0, attempt - 1)));
    const jitterMs = Math.floor(Math.random() * 250);

    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        return Math.min(maxMs, Math.max(retryAfterMs, exponentialDelayMs) + jitterMs);
    }

    return Math.min(maxMs, exponentialDelayMs + jitterMs);
};

export class TokenUsageStore {
    constructor({
        createMongoClient = (uri) => new MongoClient(uri),
        getMongoUri = () => process.env.MONGO_URI,
        setTimeoutFn = setTimeout,
        clearTimeoutFn = clearTimeout,
        flushIntervalMs = FLUSH_INTERVAL_MS,
        flushBatchSize = FLUSH_BATCH_SIZE,
        retryBaseMs = RETRY_BASE_MS,
        retryMaxMs = RETRY_MAX_MS,
        ensureIndexes = shouldEnsureRuntimeIndexes,
    } = {}) {
        this._createMongoClient = createMongoClient;
        this._getMongoUri = getMongoUri;
        this._setTimeout = setTimeoutFn;
        this._clearTimeout = clearTimeoutFn;
        this._flushIntervalMs = flushIntervalMs;
        this._flushBatchSize = flushBatchSize;
        this._retryBaseMs = retryBaseMs;
        this._retryMaxMs = retryMaxMs;
        this._client = null;
        this._collection = null;
        this._buffer = [];
        this._flushTimer = null;
        this._flushInProgress = false;
        this._retryAttempt = 0;
        this._connecting = null;
        this._indexesEnsured = false;
        this._ensureIndexesEnabled =
            typeof ensureIndexes === 'function'
                ? ensureIndexes
                : () => Boolean(ensureIndexes);
    }

    async _connect() {
        if (this._collection) return this._collection;
        if (this._connecting) return this._connecting;

        const uri = this._getMongoUri();
        if (!uri) return null;

        this._connecting = (async () => {
            try {
                this._client = this._createMongoClient(uri);
                await this._client.connect();
                const db = this._client.db(); // uses DB from URI
                this._collection = db.collection(COLLECTION_NAME);

                if (this._ensureIndexesEnabled() && !this._indexesEnsured) {
                    await this._ensureIndexes();
                    this._indexesEnsured = true;
                }

                logger.info(`TokenUsageStore connected: ${db.databaseName}.${COLLECTION_NAME}`);
                return this._collection;
            } catch (err) {
                logger.warn(`TokenUsageStore connection failed: ${err.message}`);
                this._client = null;
                this._collection = null;
                return null;
            } finally {
                this._connecting = null;
            }
        })();

        return this._connecting;
    }

    async _ensureIndexes() {
        if (!this._collection) return;

        const createIndexBestEffort = async (spec, options) => {
            try {
                await this._collection.createIndex(spec, options);
                return true;
            } catch (err) {
                logger.warn(`TokenUsageStore index creation failed: ${err.message}`);
                return false;
            }
        };

        // TTL index — auto-delete after 90 days
        await createIndexBestEffort(
            { timestamp: 1 },
            { expireAfterSeconds: TTL_DAYS * 86_400, background: true }
        );
        // Query indexes for the portal
        await createIndexBestEffort(
            { timestamp: 1, model: 1 },
            { background: true }
        );
        await createIndexBestEffort(
            { timestamp: 1, api_key_id: 1 },
            { background: true }
        );

        const uniqueEventKeyCreated = await createIndexBestEffort(
            { event_key: 1 },
            {
                background: true,
                unique: true,
                partialFilterExpression: { event_key: { $exists: true } }
            }
        );

        if (!uniqueEventKeyCreated) {
            await createIndexBestEffort(
                { event_key: 1 },
                {
                    background: true,
                    partialFilterExpression: { event_key: { $exists: true } }
                }
            );
        }
    }

    log(payload) {
        this._buffer.push({ ...payload, timestamp: new Date() });

        if (this._buffer.length >= this._flushBatchSize) {
            this._flush();
        } else if (!this._flushTimer) {
            this._scheduleFlush(this._flushIntervalMs);
        }
    }

    get pendingCount() {
        return this._buffer.length;
    }

    _scheduleFlush(delayMs) {
        if (this._flushTimer) return;

        this._flushTimer = this._setTimeout(() => this._flush(), delayMs);
        if (typeof this._flushTimer?.unref === 'function') {
            this._flushTimer.unref();
        }
    }

    async _flush() {
        if (this._flushInProgress) return;

        if (this._flushTimer) {
            this._clearTimeout(this._flushTimer);
            this._flushTimer = null;
        }

        if (this._buffer.length === 0) return;

        const batch = this._buffer.splice(0, this._flushBatchSize);
        this._flushInProgress = true;

        try {
            const col = await this._connect();
            if (!col) {
                this._buffer.unshift(...batch);
                this._scheduleRetry(new Error('MONGO_URI is not set'));
                return;
            }

            const seenEventKeys = new Set();
            const operations = [];

            for (const doc of batch) {
                if (doc.event_key) {
                    if (seenEventKeys.has(doc.event_key)) continue;
                    seenEventKeys.add(doc.event_key);
                    operations.push({
                        updateOne: {
                            filter: { event_key: doc.event_key },
                            update: { $setOnInsert: doc },
                            upsert: true
                        }
                    });
                    continue;
                }

                operations.push({
                    insertOne: {
                        document: doc
                    }
                });
            }

            if (operations.length > 0) {
                await col.bulkWrite(operations, { ordered: false });
            }

            this._retryAttempt = 0;
            if (this._buffer.length > 0) {
                this._scheduleFlush(0);
            }
        } catch (err) {
            this._buffer.unshift(...batch);
            this._scheduleRetry(err);
        } finally {
            this._flushInProgress = false;
        }
    }

    _scheduleRetry(err) {
        this._retryAttempt += 1;
        const delayMs = calculateRetryDelayMs(err, this._retryAttempt, {
            baseMs: this._retryBaseMs,
            maxMs: this._retryMaxMs,
        });
        logger.warn(`TokenUsageStore flush failed; retained ${this._buffer.length} pending events and will retry in ${delayMs}ms: ${err.message}`);
        this._scheduleFlush(delayMs);
    }

    async close() {
        await this._flush();
        if (this._client) {
            await this._client.close();
            this._client = null;
            this._collection = null;
        }
    }
}

// Singleton
const tokenUsageStore = new TokenUsageStore();
export default tokenUsageStore;
