import Redis from 'ioredis';
import { config } from '../config.js';
import logger from './logger.js';
import { RedisSearchCache } from './searchCache.js';
import { encrypt, decrypt } from './crypto.js';
import { requestState } from '../server/requestState.js';

let cache;
let connectionReady;

export const executeSearchRequest = async (request, load) => {
    if (!config.get('searchCacheEnabled')) return load();
    if (!cache) {
        const connection = config.get('searchCacheRedisUrl') || config.get('storageConnectionString');
        const redis = connection ? new Redis(connection, {
            lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0,
            connectTimeout: 1000, commandTimeout: 250,
            retryStrategy: times => Math.min(times * 500, 5000),
        }) : null;
        redis?.on('error', () => {}); // Report bounded bypass events, never connection strings.
        connectionReady = redis ? (async () => {
            let timer;
            try {
                await Promise.race([redis.connect().catch(() => {}), new Promise(resolve => {
                    timer = setTimeout(resolve, 250);
                })]);
            } finally { clearTimeout(timer); }
        })() : Promise.resolve();
        cache = new RedisSearchCache({ redis,
            namespace: config.get('searchCacheNamespace') || `${config.get('cortexId') || 'cortex'}:search:v1`,
            ttlMs: config.get('searchCacheTtlSeconds') * 1000,
            braveStorageAllowed: config.get('searchCacheBraveStorageAllowed'),
            serialize: value => {
                const encoded = encrypt(JSON.stringify(value), config.get('redisEncryptionKey'));
                if (typeof encoded !== 'string') throw new Error('Search cache encryption failed');
                return encoded;
            },
            deserialize: value => JSON.parse(decrypt(value, config.get('redisEncryptionKey'))),
            onEvent: event => logger.info(JSON.stringify({ event: 'search_cache', ...event })),
        });
    }
    await connectionReady;
    const rootRequestId = request.pathwayResolver?.rootRequestId || request.requestId;
    const result = await cache.run({ provider: request.searchCache.provider, url: request.url,
        params: request.params, headers: request.headers, requestId: request.requestId, rootRequestId }, load,
    { ...request.searchCache, isCancelled: () => requestState[rootRequestId]?.canceled || requestState[request.requestId]?.canceled });
    // Do not persist request IDs, credentials, axios config, or synthesized answers.
    // Fresh tool result IDs are still allocated by the existing tool wrappers.
    if (result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
        return { ...result, data: { ...result.data, _searchCache: result.searchCache } };
    }
    return result;
};
