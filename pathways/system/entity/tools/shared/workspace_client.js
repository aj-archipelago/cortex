// workspace_client.js
// Shared module for workspace tools: HTTP client, auto-provisioning, backend abstraction.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Agent } from 'undici';
import logger from '../../../../../lib/logger.js';
import { config } from '../../../../../config.js';
import { decrypt, encrypt } from '../../../../../lib/crypto.js';
import { loadEntityConfig } from './sys_entity_tools.js';
import { getEntityStore } from '../../../../../lib/MongoEntityStore.js';
import { getBackend } from './backends/index.js';
import { getUserContainerName, ensureContainer, generateContainerSASToken } from '../../../../../lib/blobContainerUtils.js';
import { initWarmPool, claimContainer, getWarmPoolActiveContainerNames, removeWarmPoolEntry } from './warmPool.js';

/**
 * Resolve the full workspace image reference (name:tag).
 * Combines workspaceImage + workspaceImageVersion so ACI/Docker always
 * pulls an exact version — never a cached `:latest`.
 */
export function resolveWorkspaceImage() {
    const base = config.get('workspaceImage');
    const version = config.get('workspaceImageVersion');
    // If the image already has a tag (e.g. from WORKSPACE_IMAGE env), use it as-is
    if (base.includes(':')) return base;
    // If no version configured, fall back to :latest (local dev)
    if (!version) return `${base}:latest`;
    return `${base}:${version}`;
}

// In-memory lock to prevent concurrent provisioning for the same entity
const provisioningLocks = new Map();
const reprovisionLocks = new Map();
const WORKSPACE_TRANSITION_STATUSES = new Set(['starting', 'provisioning']);
const WORKSPACE_TRANSITION_WAIT_MS = 90_000;
const WORKSPACE_TRANSITION_POLL_MS = 2_000;
const WORKSPACE_PROVISIONING_LOCK_TTL_MS = 5 * 60 * 1000;
const WORKSPACE_CHECKPOINT_PATH = '/persist/workspace.tar.gz';
const WORKSPACE_CHECKPOINT_ENCRYPTION_ALGORITHM = 'aes-256-gcm';

// Local activity mirror: entityId → timestamp (ms). Redis is the durable source
// of reaper candidates; this map only helps the current process notice fresher
// activity while it is evaluating a candidate.
const lastActivity = new Map();
const longFetchDispatchers = new Map();

let _activityRedisClient = null;
let _activityRedisClientConnectPromise = null;
let _activityRedisClientOverride;
let _workspaceCheckpointUploadOverride;
let _workspaceCheckpointContainerClientOverride;
let _workspaceLegacyShareUploadOverride;
const ACTIVITY_REAPER_HOST_ID = `${process.pid}-${crypto.randomUUID()}`;

function isValidWorkspaceEntityId(entityId) {
    return typeof entityId === 'string' && entityId.trim().length > 0;
}

function invalidWorkspaceEntityResult() {
    return { success: false, error: 'Workspace entityId is required' };
}

function getLongFetchDispatcher(timeoutMs) {
    const boundedTimeoutMs = Math.max(1, Number(timeoutMs) || 30_000);
    if (!longFetchDispatchers.has(boundedTimeoutMs)) {
        longFetchDispatchers.set(boundedTimeoutMs, new Agent({
            headersTimeout: boundedTimeoutMs,
            bodyTimeout: boundedTimeoutMs,
        }));
    }
    return longFetchDispatchers.get(boundedTimeoutMs);
}

function workspaceActivityKey(entityId) {
    return `${config.get('cortexId')}-workspace:activity:${entityId}`;
}

function workspaceActivityIndexKey() {
    return `${config.get('cortexId')}-workspace:activity-index`;
}

function workspaceReaperLockKey(entityId) {
    return `${config.get('cortexId')}-workspace:reaper-lock:${entityId}`;
}

function workspaceProvisioningLockKey(entityId) {
    return `${config.get('cortexId')}-workspace:provisioning-lock:${entityId}`;
}

function workspaceActivityTtlMs(idleTimeoutMs = config.get('workspaceIdleTimeoutMs')) {
    return Math.max((Number(idleTimeoutMs) || 0) * 2, 60 * 60 * 1000);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function workspaceContainerPrefix() {
    return config.get('workspaceContainerPrefix') || 'workspace-local';
}

function workspaceContainerNameForEntity(entityId) {
    return `${workspaceContainerPrefix()}-${entityId}`;
}

function sanitizeCheckpointPathPart(value) {
    return String(value || 'default')
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'default';
}

function workspaceCheckpointIdentityHash(value) {
    return crypto
        .createHash('sha256')
        .update(String(value || ''))
        .digest('hex');
}

function workspaceCheckpointPathPart(value) {
    const hint = sanitizeCheckpointPathPart(value).slice(0, 40);
    const hash = workspaceCheckpointIdentityHash(value);
    return hint && hint !== 'default' ? `${hint}-${hash}` : hash;
}

function workspaceCheckpointBlobPath(entityId, filename = 'workspace.tar.gz') {
    const cortexId = workspaceCheckpointPathPart(config.get('cortexId'));
    const entityKey = workspaceCheckpointPathPart(entityId);
    return `workspace-checkpoints/${cortexId}/${entityKey}/${filename}`;
}

function legacyWorkspaceCheckpointBlobPath(entityId, filename = 'workspace.tar.gz') {
    const cortexId = sanitizeCheckpointPathPart(config.get('cortexId'));
    const safeEntityId = sanitizeCheckpointPathPart(entityId);
    return `workspace-checkpoints/${cortexId}/${safeEntityId}/${filename}`;
}

function workspaceCheckpointBlobPathCandidates(entityId, filename = 'workspace.tar.gz') {
    return [
        workspaceCheckpointBlobPath(entityId, filename),
        legacyWorkspaceCheckpointBlobPath(entityId, filename),
    ].filter((blobPath, index, paths) => paths.indexOf(blobPath) === index);
}

function workspaceCheckpointBlobMetadata(entityId, extra = {}) {
    const cortexId = String(config.get('cortexId') || '');
    return {
        entityId: String(entityId || ''),
        entityHash: workspaceCheckpointIdentityHash(entityId),
        cortexId,
        cortexHash: workspaceCheckpointIdentityHash(cortexId),
        ...extra,
    };
}

function workspaceCheckpointEncryptionKeyId(keyBase64) {
    return crypto
        .createHash('sha256')
        .update(String(keyBase64 || ''))
        .digest('hex')
        .slice(0, 32);
}

function encryptWorkspaceCheckpointKey(keyBase64) {
    const systemKey = config.get('redisEncryptionKey');
    return encrypt(keyBase64, systemKey);
}

function decryptWorkspaceCheckpointKey(encryptedKey) {
    const systemKey = config.get('redisEncryptionKey');
    return decrypt(encryptedKey, systemKey);
}

function readWorkspaceCheckpointEncryptionKey(entityConfig) {
    const existing = entityConfig?.workspace?.checkpointEncryptionKey;
    if (!existing?.encryptedKey) return null;
    const keyBase64 = decryptWorkspaceCheckpointKey(existing.encryptedKey);
    if (!keyBase64) {
        throw new Error('Workspace checkpoint encryption key could not be decrypted');
    }
    return {
        algorithm: existing.algorithm || WORKSPACE_CHECKPOINT_ENCRYPTION_ALGORITHM,
        keyBase64,
        keyId: existing.keyId || workspaceCheckpointEncryptionKeyId(keyBase64),
        entityConfig,
    };
}

async function getOrCreateWorkspaceCheckpointEncryptionKey(entityId, entityConfig) {
    const existing = readWorkspaceCheckpointEncryptionKey(entityConfig);
    if (existing) return existing;

    const current = (await loadEntityConfig(entityId, { fresh: true })) || entityConfig;
    const currentKey = readWorkspaceCheckpointEncryptionKey(current);
    if (currentKey) return currentKey;

    const keyBase64 = crypto.randomBytes(32).toString('base64');
    const keyRecord = {
        algorithm: WORKSPACE_CHECKPOINT_ENCRYPTION_ALGORITHM,
        keyId: workspaceCheckpointEncryptionKeyId(keyBase64),
        encryptedKey: encryptWorkspaceCheckpointKey(keyBase64),
        createdAt: new Date().toISOString(),
    };
    const updated = {
        ...current,
        workspace: {
            ...(current?.workspace || {}),
            checkpointEncryptionKey: keyRecord,
        },
    };
    await getEntityStore().upsertEntity(updated);
    return {
        algorithm: keyRecord.algorithm,
        keyBase64,
        keyId: keyRecord.keyId,
        entityConfig: updated,
    };
}

function buildWorkspaceCheckpointRestoreEncryption(entityConfig) {
    const checkpointEncryption = entityConfig?.workspace?.checkpointEncryption;
    if (!checkpointEncryption) return null;
    const keyRecord = entityConfig?.workspace?.checkpointEncryptionKey;
    if (!keyRecord?.encryptedKey) {
        throw new Error('Workspace checkpoint is encrypted but no checkpoint encryption key is stored');
    }
    const keyBase64 = decryptWorkspaceCheckpointKey(keyRecord.encryptedKey);
    if (!keyBase64) {
        throw new Error('Workspace checkpoint encryption key could not be decrypted');
    }
    return {
        algorithm: checkpointEncryption.algorithm || keyRecord.algorithm || WORKSPACE_CHECKPOINT_ENCRYPTION_ALGORITHM,
        keyBase64,
        keyId: checkpointEncryption.keyId || keyRecord.keyId || workspaceCheckpointEncryptionKeyId(keyBase64),
        ivBase64: checkpointEncryption.ivBase64,
        tagBase64: checkpointEncryption.tagBase64,
        compression: checkpointEncryption.compression || entityConfig?.workspace?.checkpointCompression || 'gzip',
    };
}

function checkpointEncryptionMetadata(encryption = {}) {
    if (!encryption?.algorithm || !encryption?.ivBase64 || !encryption?.tagBase64) return {};
    const metadata = {
        checkpointEncryptionAlgorithm: encryption.algorithm,
        checkpointEncryptionKeyId: encryption.keyId || '',
        checkpointEncryptionIv: encryption.ivBase64,
        checkpointEncryptionTag: encryption.tagBase64,
    };
    if (encryption.compression) {
        metadata.checkpointCompression = encryption.compression;
    }
    return metadata;
}

function checkpointEncryptionFromMetadata(metadata = {}) {
    const algorithm = metadataValue(metadata, 'checkpointEncryptionAlgorithm');
    const ivBase64 = metadataValue(metadata, 'checkpointEncryptionIv');
    const tagBase64 = metadataValue(metadata, 'checkpointEncryptionTag');
    if (!algorithm || !ivBase64 || !tagBase64) return null;
    return {
        algorithm,
        keyId: metadataValue(metadata, 'checkpointEncryptionKeyId') || null,
        ivBase64,
        tagBase64,
        compression: metadataValue(metadata, 'checkpointCompression') || 'gzip',
    };
}

function metadataValue(metadata, key) {
    const lowerKey = key.toLowerCase();
    for (const [candidateKey, value] of Object.entries(metadata || {})) {
        if (candidateKey.toLowerCase() === lowerKey) {
            return value == null ? '' : String(value);
        }
    }
    return null;
}

function validateWorkspaceCheckpointMetadata(metadata, entityId) {
    const expected = workspaceCheckpointBlobMetadata(entityId);
    const entityIdValue = metadataValue(metadata, 'entityId');
    const entityHashValue = metadataValue(metadata, 'entityHash');
    const cortexIdValue = metadataValue(metadata, 'cortexId');
    const cortexHashValue = metadataValue(metadata, 'cortexHash');

    if (!entityIdValue && !entityHashValue) {
        throw new Error('Workspace checkpoint is missing entity identity metadata');
    }
    if (entityIdValue && entityIdValue !== expected.entityId) {
        throw new Error('Workspace checkpoint entity metadata does not match requested entity');
    }
    if (entityHashValue && entityHashValue !== expected.entityHash) {
        throw new Error('Workspace checkpoint entity hash does not match requested entity');
    }
    if (cortexIdValue && cortexIdValue !== expected.cortexId) {
        throw new Error('Workspace checkpoint cortex metadata does not match this Cortex instance');
    }
    if (cortexHashValue && cortexHashValue !== expected.cortexHash) {
        throw new Error('Workspace checkpoint cortex hash does not match this Cortex instance');
    }

    return true;
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function getWorkspaceCheckpointMetadata(workspace = {}) {
    if (!workspace?.checkpointBlobPath) return {};
    const metadata = {
        checkpointBlobPath: workspace.checkpointBlobPath,
        checkpointPreviousBlobPath: workspace.checkpointPreviousBlobPath || null,
        checkpointSizeBytes: workspace.checkpointSizeBytes || null,
        checkpointSizeMB: workspace.checkpointSizeMB || null,
        checkpointedAt: workspace.checkpointedAt || null,
    };
    if (workspace.checkpointEncryption) {
        metadata.checkpointEncryption = workspace.checkpointEncryption;
    }
    if (workspace.checkpointEncryptionKey) {
        metadata.checkpointEncryptionKey = workspace.checkpointEncryptionKey;
    }
    return metadata;
}

function getLegacyShareName(workspace = {}) {
    if (workspace?.legacyShareName) return workspace.legacyShareName;
    if (workspace?.shareName) return workspace.shareName;
    if (workspace?.checkpointBlobPath) return null;
    if (workspace?.containerId && workspace?.imageVersion && !isPersistentCheckpointWorkspace(workspace.imageVersion)) {
        return workspace.containerId;
    }
    if (workspace?.containerId && !workspace?.url && !workspace?.imageVersion) {
        return workspace.containerId;
    }
    return null;
}

function isActivityRedisConfigured() {
    return _activityRedisClientOverride !== undefined || Boolean(config.get('storageConnectionString'));
}

async function getActivityRedisClient() {
    if (_activityRedisClientOverride !== undefined) return _activityRedisClientOverride;
    if (_activityRedisClient?.status === 'ready') return _activityRedisClient;
    if (_activityRedisClientConnectPromise) return _activityRedisClientConnectPromise;
    if (_activityRedisClient) {
        try {
            _activityRedisClient.disconnect();
        } catch {
            // Best effort cleanup before replacing a stale socket.
        }
        _activityRedisClient = null;
    }

    try {
        const connectionString = config.get('storageConnectionString');
        if (!connectionString) return null;

        const Redis = (await import('ioredis')).default;
        const client = new Redis(connectionString, {
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
            enableReadyCheck: true,
            lazyConnect: true,
            connectTimeout: 10000,
        });

        client.on('error', (error) => {
            logger.error(`[WorkspaceActivity] Redis client error: ${error.message}`);
        });

        _activityRedisClient = client;
        _activityRedisClientConnectPromise = client.connect()
            .then(() => {
                _activityRedisClientConnectPromise = null;
                return client;
            })
            .catch((e) => {
                _activityRedisClientConnectPromise = null;
                if (_activityRedisClient === client) {
                    _activityRedisClient = null;
                }
                try {
                    client.disconnect();
                } catch {
                    // Best effort cleanup.
                }
                throw e;
            });

        return await _activityRedisClientConnectPromise;
    } catch (e) {
        logger.error(`[WorkspaceActivity] Failed to create Redis client: ${e.message}`);
        if (_activityRedisClient) {
            try {
                _activityRedisClient.disconnect();
            } catch {
                // Best effort cleanup.
            }
            _activityRedisClient = null;
        }
        _activityRedisClientConnectPromise = null;
        return null;
    }
}

async function writeWorkspaceActivityToRedis(entityId, timestamp, idleTimeoutMs) {
    const redis = await getActivityRedisClient();
    if (!redis) return false;

    await redis.set(
        workspaceActivityKey(entityId),
        String(timestamp),
        'PX',
        workspaceActivityTtlMs(idleTimeoutMs),
    );
    await redis.zadd(workspaceActivityIndexKey(), timestamp, entityId);
    return true;
}

async function readWorkspaceActivityFromRedis(entityId, redis) {
    if (!redis) return { ok: true, timestamp: 0 };

    try {
        const value = await redis.get(workspaceActivityKey(entityId));
        const timestamp = Number(value);
        return { ok: true, timestamp: Number.isFinite(timestamp) ? timestamp : 0 };
    } catch (e) {
        logger.warn(`Failed to read workspace activity from Redis for ${entityId}: ${e.message}`);
        return { ok: false, timestamp: 0 };
    }
}

async function readLatestWorkspaceActivityTimestamp(entityId, minimumTimestamp = 0) {
    const localTimestamp = lastActivity.get(entityId) || 0;
    const redis = await getActivityRedisClient();
    if (!redis) {
        return {
            ok: !isActivityRedisConfigured(),
            timestamp: Math.max(minimumTimestamp, localTimestamp),
        };
    }

    const redisActivity = await readWorkspaceActivityFromRedis(entityId, redis);
    if (!redisActivity.ok) {
        return { ok: false, timestamp: Math.max(minimumTimestamp, localTimestamp) };
    }
    return {
        ok: true,
        timestamp: Math.max(minimumTimestamp, localTimestamp, redisActivity.timestamp),
    };
}

async function removeWorkspaceActivityFromRedis(entityId) {
    const redis = await getActivityRedisClient();
    if (!redis) return;

    try {
        await redis.del(workspaceActivityKey(entityId));
        await redis.zrem(workspaceActivityIndexKey(), entityId);
    } catch (e) {
        logger.warn(`Failed to clear workspace activity in Redis for ${entityId}: ${e.message}`);
    }
}

function recordWorkspaceActivity(entityId) {
    const timestamp = Date.now();
    lastActivity.set(entityId, timestamp);
    writeWorkspaceActivityToRedis(entityId, timestamp).catch((e) => {
        logger.warn(`Failed to record workspace activity in Redis for ${entityId}: ${e.message}`);
    });
}

async function getWorkspaceReaperCandidates(redis, now, minimumIdleMs) {
    if (!redis) {
        if (isActivityRedisConfigured()) {
            logger.warn('Skipping idle workspace reap; Redis activity index is unavailable');
            return [];
        }

        return Array.from(lastActivity.entries())
            .filter(([, timestamp]) => now - timestamp >= minimumIdleMs)
            .map(([entityId]) => entityId);
    }

    const cutoff = now - minimumIdleMs;
    try {
        return await redis.zrangebyscore(workspaceActivityIndexKey(), 0, cutoff);
    } catch (e) {
        logger.warn(`Failed to read workspace activity index from Redis: ${e.message}`);
        return [];
    }
}

async function acquireWorkspaceReaperLock(entityId) {
    const redis = await getActivityRedisClient();
    if (!redis) {
        if (isActivityRedisConfigured()) {
            logger.warn(`Skipping idle reap for entity ${entityId}; Redis activity lock is unavailable`);
            return { acquired: false, redis: null };
        }
        return { acquired: true, redis: null };
    }

    try {
        const result = await redis.set(
            workspaceReaperLockKey(entityId),
            ACTIVITY_REAPER_HOST_ID,
            'PX',
            60_000,
            'NX',
        );
        return { acquired: result === 'OK', redis };
    } catch (e) {
        logger.warn(`Failed to acquire workspace reaper lock for ${entityId}: ${e.message}`);
        return { acquired: false, redis };
    }
}

async function releaseWorkspaceReaperLock(entityId, redis) {
    if (!redis) return;

    try {
        const key = workspaceReaperLockKey(entityId);
        const owner = await redis.get(key);
        if (owner === ACTIVITY_REAPER_HOST_ID) {
            await redis.del(key);
        }
    } catch (e) {
        logger.warn(`Failed to release workspace reaper lock for ${entityId}: ${e.message}`);
    }
}

async function acquireWorkspaceProvisioningLock(entityId) {
    const redis = await getActivityRedisClient();
    if (!redis) {
        return { acquired: true, redis: null, key: null, token: null };
    }

    const key = workspaceProvisioningLockKey(entityId);
    const token = `${ACTIVITY_REAPER_HOST_ID}-${crypto.randomUUID()}`;
    try {
        const result = await redis.set(key, token, 'PX', WORKSPACE_PROVISIONING_LOCK_TTL_MS, 'NX');
        return { acquired: result === 'OK', redis, key, token };
    } catch (e) {
        logger.warn(`Failed to acquire workspace provisioning lock for ${entityId}: ${e.message}`);
        return { acquired: true, redis: null, key: null, token: null };
    }
}

async function releaseWorkspaceProvisioningLock(lock) {
    if (!lock?.redis || !lock.key || !lock.token) return;

    try {
        const owner = await lock.redis.get(lock.key);
        if (owner === lock.token) {
            await lock.redis.del(lock.key);
        }
    } catch (e) {
        logger.warn(`Failed to release workspace provisioning lock ${lock.key}: ${e.message}`);
    }
}

/**
 * Parse memory limit string (e.g. '512m', '1g') to megabytes.
 * Backend-agnostic — returns MB for use by any backend.
 */
export function parseMemoryToMB(str) {
    const match = str.toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/);
    if (!match) return 512; // default 512MB

    const num = parseFloat(match[1]);
    const unit = match[2];

    switch (unit) {
        case 'k': return Math.round(num / 1024);
        case 'm': return Math.round(num);
        case 'g': return Math.round(num * 1024);
        default: return Math.round(num / (1024 * 1024)); // assume bytes
    }
}

/**
 * Make an authenticated HTTP request to an entity's workspace client.
 * Auto-provisions the workspace if not yet configured.
 *
 * @param {string} entityId - Entity UUID
 * @param {string} endpoint - Path (e.g. '/shell', '/read')
 * @param {Object} [body] - JSON body for POST requests
 * @param {Object} [options]
 * @param {string} [options.method] - HTTP method (default: POST, or GET if no body)
 * @param {number} [options.timeoutMs] - Request timeout in ms (default: 30000)
 * @returns {Promise<Object>} Parsed JSON response
 */
export async function workspaceRequest(entityId, endpoint, body = null, options = {}) {
    if (!isValidWorkspaceEntityId(entityId)) {
        logger.warn('Workspace request skipped: missing entityId');
        return invalidWorkspaceEntityResult();
    }

    const method = options.method || (body ? 'POST' : 'GET');
    const timeoutMs = options.timeoutMs || 30000;
    const shouldRecordActivity = options.recordActivity !== false;
    const markActivity = () => {
        if (shouldRecordActivity) recordWorkspaceActivity(entityId);
    };
    const onWorkspaceLifecycle = typeof options.onWorkspaceLifecycle === 'function'
        ? options.onWorkspaceLifecycle
        : null;
    const workspaceResult = await ensureWorkspaceReady(entityId, options);
    if (!workspaceResult.success) {
        return workspaceResult;
    }
    let { entityConfig } = workspaceResult;

    const { url, secret } = entityConfig.workspace;
    markActivity();

    try {
        const fetchOptions = {
            method,
            headers: {
                'x-workspace-secret': secret,
                'Content-Type': 'application/json',
            },
            signal: AbortSignal.timeout(timeoutMs),
        };

        if (body && method !== 'GET') {
            fetchOptions.body = JSON.stringify(body);
        }

        const response = await fetch(`${url}${endpoint}`, fetchOptions);

        markActivity();

        if (response.status === 401) {
            // Secret mismatch — likely ACI restarted the container, reverting
            // its in-memory secret to the bootstrap secret from the env var.
            // Try reconfiguring with the bootstrap secret first (fast path),
            // then fall back to full reprovision if that fails.
            const workspace = entityConfig.workspace;

            if (workspace.bootstrapSecret) {
                logger.warn(`Workspace auth failed for ${entityId} — attempting reconfigure with bootstrap secret`);
                try {
                    const backend = await getBackend();
                    await reconfigureForEntity(entityId, entityConfig, {
                        containerName: workspace.containerId,
                        shareName: workspace.shareName || null,
                        legacyShareName: workspace.legacyShareName || null,
                        url: workspace.url,
                        bootstrapSecret: workspace.bootstrapSecret,
                        containerId: workspace.containerId,
                        claimedFromPool: workspace.claimedFromPool,
                    }, backend, { destroyOnFailure: false });

                    // Retry the request with the fresh secret
                    entityConfig = await loadEntityConfig(entityId);
                    const retryOptions = {
                        method,
                        headers: {
                            'x-workspace-secret': entityConfig.workspace.secret,
                            'Content-Type': 'application/json',
                        },
                        signal: AbortSignal.timeout(timeoutMs),
                    };
                    if (body && method !== 'GET') {
                        retryOptions.body = JSON.stringify(body);
                    }
                    const retryResponse = await fetch(`${entityConfig.workspace.url}${endpoint}`, retryOptions);
                    markActivity();
                    if (retryResponse.status === 401) {
                        // Reconfigure succeeded but auth still fails — something else is wrong
                        logger.warn(`Workspace auth still failing after reconfigure for ${entityId} — full reprovision`);
                    } else {
                        const retryData = await retryResponse.json();
                        if (retryData.error) {
                            return { success: false, error: retryData.error };
                        }
                        return { success: true, ...retryData };
                    }
                } catch (reconfigErr) {
                    logger.warn(`Reconfigure failed for ${entityId}: ${reconfigErr.message} — falling back to full reprovision`);
                }
            }

            // Full reprovision fallback
            logger.warn(`Workspace auth failed for ${entityId} — re-provisioning`);
            try {
                await getEntityStore().upsertEntity({
                    ...entityConfig,
                    workspace: { ...entityConfig.workspace, status: 'error' },
                });
            } catch { /* best effort */ }

            const provisionResult = await provisionWorkspace(entityId, entityConfig, options);
            if (!provisionResult.success) {
                return { success: false, error: `Workspace auth failed and re-provision failed: ${provisionResult.error}` };
            }

            // Retry the request with fresh config
            entityConfig = await loadEntityConfig(entityId);
            if (!entityConfig?.workspace?.url) {
                return { success: false, error: 'Re-provision completed but config not available' };
            }
            try {
                const retryOptions = {
                    method,
                    headers: {
                        'x-workspace-secret': entityConfig.workspace.secret,
                        'Content-Type': 'application/json',
                    },
                    signal: AbortSignal.timeout(timeoutMs),
                };
                if (body && method !== 'GET') {
                    retryOptions.body = JSON.stringify(body);
                }
                const retryResponse = await fetch(`${entityConfig.workspace.url}${endpoint}`, retryOptions);
                markActivity();
                if (retryResponse.status === 401) {
                    return { success: false, error: 'Authentication failed after re-provision' };
                }
                const retryData = await retryResponse.json();
                if (retryData.error) {
                    return { success: false, error: retryData.error };
                }
                return { success: true, ...retryData };
            } catch (retryErr) {
                return { success: false, error: `Workspace re-provisioned but request still failed: ${retryErr.message}` };
            }
        }

        const data = await response.json();

        if (data.error) {
            return { success: false, error: data.error };
        }

        return { success: true, ...data };
    } catch (e) {
        // Detect connection-level failures (ECONNREFUSED, ENOTFOUND, ECONNRESET, "fetch failed", etc.)
        const causeCode = e.cause?.code;
        const isConnectionError =
            e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND' ||
            causeCode === 'ECONNREFUSED' || causeCode === 'ENOTFOUND' || causeCode === 'ECONNRESET' ||
            (e.name === 'TypeError' && e.message === 'fetch failed');

        if (isConnectionError) {
            // Container is dead — re-provision and retry the request in the same call
            logger.warn(`Workspace for ${entityId} unreachable — re-provisioning`);
            try {
                await getEntityStore().upsertEntity({
                    ...entityConfig,
                    workspace: { ...entityConfig.workspace, status: 'error' },
                });
            } catch { /* best effort */ }

            await emitWorkspaceLifecycle(onWorkspaceLifecycle, { type: 'start', phase: 'reconnect', message: 'Reconnecting workspace' });
            const provisionResult = await provisionWorkspace(entityId, entityConfig, options);
            await emitWorkspaceLifecycle(onWorkspaceLifecycle, {
                type: 'finish',
                phase: 'reconnect',
                success: provisionResult.success,
                error: provisionResult.error,
            });
            if (!provisionResult.success) {
                return { success: false, error: `Workspace died and re-provision failed: ${provisionResult.error}` };
            }

            // Retry the request with fresh config
            entityConfig = await loadEntityConfig(entityId);
            if (!entityConfig?.workspace?.url) {
                return { success: false, error: 'Re-provision completed but config not available' };
            }
            try {
                const retryOptions = {
                    method,
                    headers: {
                        'x-workspace-secret': entityConfig.workspace.secret,
                        'Content-Type': 'application/json',
                    },
                    signal: AbortSignal.timeout(timeoutMs),
                };
                if (body && method !== 'GET') {
                    retryOptions.body = JSON.stringify(body);
                }
                const retryResponse = await fetch(`${entityConfig.workspace.url}${endpoint}`, retryOptions);
                markActivity();
                const retryData = await retryResponse.json();
                if (retryData.error) {
                    return { success: false, error: retryData.error };
                }
                return { success: true, ...retryData };
            } catch (retryErr) {
                return { success: false, error: `Workspace re-provisioned but request still failed: ${retryErr.message}` };
            }
        }

        if (e.name === 'TimeoutError' || e.name === 'AbortError') {
            return { success: false, error: `Request timed out after ${Math.round(timeoutMs / 1000)}s` };
        }

        logger.error(`Workspace request failed for entity ${entityId}: ${e.message}`);
        return { success: false, error: `Workspace request failed: ${e.message}` };
    }
}

/**
 * Provision a workspace container for an entity via the configured backend.
 *
 * @param {string} entityId - Entity UUID
 * @param {Object} entityConfig - Current entity config
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function provisionWorkspace(entityId, entityConfig, options = {}) {
    if (!isValidWorkspaceEntityId(entityId)) {
        logger.warn('Workspace provisioning skipped: missing entityId');
        return invalidWorkspaceEntityResult();
    }

    // Acquire per-entity lock
    if (provisioningLocks.has(entityId)) {
        // Wait for existing provisioning to finish
        try {
            await provisioningLocks.get(entityId);
            return { success: true };
        } catch {
            return { success: false, error: 'Concurrent provisioning failed' };
        }
    }

    let distributedLock = await acquireWorkspaceProvisioningLock(entityId);
    if (!distributedLock.acquired) {
        logger.info(`Workspace provisioning already in progress for entity ${entityId}; waiting for readiness`);
        const transitionResult = await waitForWorkspaceTransition(entityId, options);
        if (transitionResult.success && transitionResult.entityConfig?.workspace?.status === 'running' && transitionResult.entityConfig.workspace.url) {
            return transitionResult;
        }

        distributedLock = await acquireWorkspaceProvisioningLock(entityId);
        if (!distributedLock.acquired) {
            return transitionResult.success
                ? { success: false, error: 'Workspace provisioning lock is still held' }
                : transitionResult;
        }
        entityConfig = (await loadEntityConfig(entityId, { fresh: true })) || entityConfig;
    }

    const provisionPromise = _doProvision(entityId, entityConfig);
    provisioningLocks.set(entityId, provisionPromise);

    try {
        const result = await provisionPromise;
        return result;
    } finally {
        provisioningLocks.delete(entityId);
        await releaseWorkspaceProvisioningLock(distributedLock);
    }
}

async function emitWorkspaceLifecycle(onWorkspaceLifecycle, event) {
    if (!onWorkspaceLifecycle) return;
    try {
        await onWorkspaceLifecycle(event);
    } catch (e) {
        logger.warn(`Workspace lifecycle message failed: ${e.message}`);
    }
}

async function getWorkspaceCheckpointContainerClient(storageConfig = getWorkspaceCheckpointStorageConfig(), options = {}) {
    if (!options.ignoreOverride && _workspaceCheckpointContainerClientOverride) {
        return _workspaceCheckpointContainerClientOverride;
    }

    const { accountName, accountKey, containerName } = storageConfig;
    if (!accountName || !accountKey || !containerName) {
        throw new Error('Workspace checkpoint storage account credentials and AZURE_BLOB_CONTAINER_NAME are required for workspace checkpoints');
    }

    if (options.ensure !== false) {
        await ensureContainer(accountName, accountKey, containerName);
    }
    const { BlobServiceClient, StorageSharedKeyCredential } = await import('@azure/storage-blob');
    const credential = new StorageSharedKeyCredential(accountName, accountKey);
    const blobServiceClient = new BlobServiceClient(
        `https://${accountName}.blob.core.windows.net`,
        credential,
    );
    return blobServiceClient.getContainerClient(containerName);
}

function getWorkspaceCheckpointStorageConfig() {
    const workspaceAccountName = config.get('workspaceAzureFilesStorageAccountName');
    const workspaceAccountKey = config.get('workspaceAzureFilesStorageAccountKey');
    const useWorkspaceStorage = Boolean(workspaceAccountName || workspaceAccountKey);

    return {
        accountName: useWorkspaceStorage ? workspaceAccountName : config.get('azureStorageAccountName'),
        accountKey: useWorkspaceStorage ? workspaceAccountKey : config.get('azureStorageAccountKey'),
        containerName: config.get('azureBlobContainerName'),
    };
}

function getLegacyWorkspaceCheckpointStorageConfig() {
    return {
        accountName: config.get('azureStorageAccountName'),
        accountKey: config.get('azureStorageAccountKey'),
        containerName: config.get('azureBlobContainerName'),
    };
}

function sameWorkspaceCheckpointStorage(left, right) {
    return left?.accountName === right?.accountName && left?.containerName === right?.containerName;
}

function getWorkspaceCheckpointStorageConfigs() {
    const preferred = getWorkspaceCheckpointStorageConfig();
    const legacy = getLegacyWorkspaceCheckpointStorageConfig();
    if (!legacy.accountName || !legacy.accountKey || sameWorkspaceCheckpointStorage(preferred, legacy)) {
        return [preferred];
    }
    return [preferred, legacy];
}

async function workspaceCheckpointBlobExists(blobPath, storageConfig) {
    if (!storageConfig.accountName || !storageConfig.accountKey || !storageConfig.containerName) {
        return false;
    }
    try {
        const containerClient = await getWorkspaceCheckpointContainerClient(storageConfig, {
            ensure: false,
            ignoreOverride: true,
        });
        return await containerClient.getBlockBlobClient(blobPath).exists();
    } catch (e) {
        logger.warn(`Could not check workspace checkpoint blob ${blobPath} in ${storageConfig.accountName}: ${e.message}`);
        return false;
    }
}

async function validateWorkspaceCheckpointBlobIdentity(blobPath, entityId, storageConfig) {
    const containerClient = await getWorkspaceCheckpointContainerClient(storageConfig, {
        ensure: false,
        ignoreOverride: true,
    });
    const properties = await containerClient.getBlockBlobClient(blobPath).getProperties();
    validateWorkspaceCheckpointMetadata(properties.metadata || {}, entityId);
}

async function readWorkspaceCheckpointBlobFields(blobPath, entityId, storageConfig) {
    const containerClient = await getWorkspaceCheckpointContainerClient(storageConfig, {
        ensure: false,
    });
    const properties = await containerClient.getBlockBlobClient(blobPath).getProperties();
    validateWorkspaceCheckpointMetadata(properties.metadata || {}, entityId);

    const metadataCheckpointedAt = metadataValue(properties.metadata || {}, 'checkpointedAt');
    const checkpointedAtMs = parseTimestampMs(metadataCheckpointedAt)
        || parseTimestampMs(properties.lastModified);
    const sizeBytes = properties.contentLength || null;
    return {
        checkpointBlobPath: blobPath,
        checkpointPreviousBlobPath: blobPath.endsWith('/workspace.tar.gz')
            ? blobPath.replace(/\/workspace\.tar\.gz$/, '/workspace.prev.tar.gz')
            : workspaceCheckpointBlobPath(entityId, 'workspace.prev.tar.gz'),
        checkpointSizeBytes: sizeBytes,
        checkpointSizeMB: sizeBytes
            ? Math.round(sizeBytes / 1024 / 1024 * 100) / 100
            : null,
        checkpointedAt: checkpointedAtMs
            ? new Date(checkpointedAtMs).toISOString()
            : null,
        checkpointEncryption: checkpointEncryptionFromMetadata(properties.metadata || {}),
        checkpointCompression: metadataValue(properties.metadata || {}, 'checkpointCompression') || null,
    };
}

async function readExistingWorkspaceCheckpointBlobFields(entityId, workspace = {}) {
    const candidatePaths = workspace.checkpointBlobPath
        ? [workspace.checkpointBlobPath]
        : workspaceCheckpointBlobPathCandidates(entityId);

    for (const candidatePath of candidatePaths) {
        for (const storageConfig of getWorkspaceCheckpointStorageConfigs()) {
            try {
                return await readWorkspaceCheckpointBlobFields(candidatePath, entityId, storageConfig);
            } catch (e) {
                if (e.statusCode === 404 || e.code === 'BlobNotFound') continue;
                logger.warn(`Could not read workspace checkpoint blob ${candidatePath} in ${storageConfig.accountName}: ${e.message}`);
            }
        }
    }
    return null;
}

async function createWorkspaceCheckpointSasUrl(blobPath, permissions, storageConfig, options = {}) {
    const { accountName, accountKey, containerName } = storageConfig;
    if (!accountName || !accountKey || !containerName) {
        throw new Error('Workspace checkpoint storage account credentials and AZURE_BLOB_CONTAINER_NAME are required for workspace checkpoints');
    }

    const {
        StorageSharedKeyCredential,
        BlobSASPermissions,
        generateBlobSASQueryParameters,
    } = await import('@azure/storage-blob');
    const credential = new StorageSharedKeyCredential(accountName, accountKey);
    const startsOn = new Date(Date.now() - 5 * 60 * 1000);
    const expiresOn = new Date(Date.now() + (options.sasTtlMs || 30 * 60 * 1000));
    const sas = generateBlobSASQueryParameters({
        containerName,
        blobName: blobPath,
        permissions: BlobSASPermissions.parse(permissions),
        startsOn,
        expiresOn,
    }, credential).toString();

    return `https://${accountName}.blob.core.windows.net/${containerName}/${encodeURI(blobPath)}?${sas}`;
}

async function copyWorkspaceCheckpointFromLegacyStorage(blobPath, legacyStorage, preferredStorage, options = {}) {
    const sourceUrl = await createWorkspaceCheckpointSasUrl(blobPath, 'r', legacyStorage, {
        ...options,
        sasTtlMs: options.sasTtlMs || 60 * 60 * 1000,
    });
    const preferredContainer = await getWorkspaceCheckpointContainerClient(preferredStorage, { ignoreOverride: true });
    const destinationBlob = preferredContainer.getBlockBlobClient(blobPath);
    const poller = await destinationBlob.beginCopyFromURL(sourceUrl, { intervalInMs: 1000 });
    const result = await poller.pollUntilDone();
    if (result.copyStatus && result.copyStatus !== 'success') {
        throw new Error(`copy status ${result.copyStatus}`);
    }
}

async function getReadableWorkspaceCheckpointStorageConfig(blobPath, options = {}) {
    const preferred = getWorkspaceCheckpointStorageConfig();
    if (await workspaceCheckpointBlobExists(blobPath, preferred)) {
        if (options.entityId) {
            await validateWorkspaceCheckpointBlobIdentity(blobPath, options.entityId, preferred);
        }
        return preferred;
    }

    const legacy = getLegacyWorkspaceCheckpointStorageConfig();
    if (!legacy.accountName || !legacy.accountKey || sameWorkspaceCheckpointStorage(preferred, legacy)) {
        return preferred;
    }
    if (!await workspaceCheckpointBlobExists(blobPath, legacy)) {
        return preferred;
    }
    if (options.entityId) {
        await validateWorkspaceCheckpointBlobIdentity(blobPath, options.entityId, legacy);
    }

    try {
        await copyWorkspaceCheckpointFromLegacyStorage(blobPath, legacy, preferred, options);
        logger.info(`Copied legacy workspace checkpoint blob ${blobPath} into preferred storage account ${preferred.accountName}`);
        return preferred;
    } catch (e) {
        logger.warn(`Could not copy legacy workspace checkpoint blob ${blobPath} into preferred storage: ${e.message}; restoring from legacy storage`);
        return legacy;
    }
}

function workspaceCheckpointBlobPathsForDestroy(entityId, workspace = {}) {
    const paths = new Set();
    if (workspace.checkpointBlobPath) paths.add(workspace.checkpointBlobPath);
    if (workspace.checkpointPreviousBlobPath) paths.add(workspace.checkpointPreviousBlobPath);
    if (paths.size > 0) {
        paths.add(workspaceCheckpointBlobPath(entityId));
        paths.add(workspaceCheckpointBlobPath(entityId, 'workspace.prev.tar.gz'));
    }
    return [...paths];
}

async function deleteWorkspaceCheckpointBlobs(entityId, workspace = {}) {
    const blobPaths = workspaceCheckpointBlobPathsForDestroy(entityId, workspace);
    if (blobPaths.length === 0) return { deleted: 0, attempted: 0 };

    let deleted = 0;
    let attempted = 0;
    for (const storageConfig of getWorkspaceCheckpointStorageConfigs()) {
        const containerClient = await getWorkspaceCheckpointContainerClient(storageConfig);
        for (const blobPath of blobPaths) {
            attempted++;
            const result = await containerClient.getBlockBlobClient(blobPath).deleteIfExists();
            if (result.succeeded) deleted += 1;
        }
    }
    return { deleted, attempted };
}

async function recoverExistingWorkspaceCheckpoint(entityId, entityConfig) {
    if (entityConfig?.workspace?.checkpointBlobPath) return entityConfig;

    let checkpointFields = null;
    try {
        checkpointFields = await readExistingWorkspaceCheckpointBlobFields(entityId, entityConfig?.workspace);
    } catch (e) {
        logger.warn(`Could not validate existing workspace checkpoint for ${entityId}: ${e.message}`);
        return entityConfig;
    }
    if (!checkpointFields) return entityConfig;

    logger.info(`Recovered existing workspace checkpoint metadata for ${entityId}`);
    return {
        ...entityConfig,
        workspace: {
            ...(entityConfig.workspace || {}),
            ...checkpointFields,
        },
    };
}

async function recoverFreshWorkspaceCheckpointFromBlob(entityId, entityConfig, minimumTimestamp) {
    if (!entityConfig?.workspace?.checkpointBlobPath) return null;

    const checkpointFields = await readExistingWorkspaceCheckpointBlobFields(entityId, entityConfig.workspace);
    if (!checkpointFields || !checkpointFields.checkpointedAt) return null;
    if (minimumTimestamp && parseTimestampMs(checkpointFields.checkpointedAt) < minimumTimestamp) return null;

    const current = (await loadEntityConfig(entityId, { fresh: true })) || entityConfig;
    if (!current?.workspace) return null;

    const updated = {
        ...current,
        workspace: {
            ...current.workspace,
            ...checkpointFields,
        },
    };
    await getEntityStore().upsertEntity(updated);
    return updated;
}

async function createWorkspaceCheckpointReadUrl(blobPath, options = {}) {
    if (options.checkpointSasUrl) return options.checkpointSasUrl;

    const storageConfig = await getReadableWorkspaceCheckpointStorageConfig(blobPath, options);
    const { accountName, accountKey, containerName } = storageConfig;
    if (!accountName || !accountKey || !containerName) {
        throw new Error('Workspace checkpoint storage account credentials and AZURE_BLOB_CONTAINER_NAME are required for workspace checkpoint restore');
    }

    return createWorkspaceCheckpointSasUrl(blobPath, 'r', storageConfig, options);
}

async function createWorkspaceCheckpointWriteUrl(blobPath, options = {}) {
    if (options.checkpointWriteSasUrl) return options.checkpointWriteSasUrl;

    const { accountName, accountKey, containerName } = getWorkspaceCheckpointStorageConfig();
    if (!accountName || !accountKey || !containerName) {
        throw new Error('Workspace checkpoint storage account credentials and AZURE_BLOB_CONTAINER_NAME are required for workspace checkpoint upload');
    }

    await ensureContainer(accountName, accountKey, containerName);
    return createWorkspaceCheckpointSasUrl(blobPath, 'cw', { accountName, accountKey, containerName }, options);
}

async function copyExistingWorkspaceCheckpointToPrevious(entityId, currentBlobPath, previousBlobPath, options = {}) {
    if (!currentBlobPath || !previousBlobPath) return false;
    const storageConfig = getWorkspaceCheckpointStorageConfig();
    if (!await workspaceCheckpointBlobExists(currentBlobPath, storageConfig)) return false;
    await validateWorkspaceCheckpointBlobIdentity(currentBlobPath, entityId, storageConfig);
    const sourceUrl = await createWorkspaceCheckpointSasUrl(currentBlobPath, 'r', storageConfig, {
        ...options,
        sasTtlMs: options.sasTtlMs || 60 * 60 * 1000,
    });
    const containerClient = await getWorkspaceCheckpointContainerClient(storageConfig, { ignoreOverride: true });
    const destinationBlob = containerClient.getBlockBlobClient(previousBlobPath);
    const poller = await destinationBlob.beginCopyFromURL(sourceUrl, { intervalInMs: 1000 });
    const result = await poller.pollUntilDone();
    if (result.copyStatus && result.copyStatus !== 'success') {
        throw new Error(`copy status ${result.copyStatus}`);
    }
    return true;
}

function getWorkspaceFilesStorageAccount() {
    return {
        accountName: config.get('workspaceAzureFilesStorageAccountName')
            || config.get('azureStorageAccountName'),
        accountKey: config.get('workspaceAzureFilesStorageAccountKey')
            || config.get('azureStorageAccountKey'),
    };
}

async function uploadWorkspaceArchiveFromLegacyShare(entityId, workspace, archivePath, blobPath) {
    const shareName = workspace?.legacyShareName || workspace?.shareName;
    if (!shareName) {
        return null;
    }
    if (archivePath !== WORKSPACE_CHECKPOINT_PATH) {
        throw new Error(`Cannot copy non-standard legacy checkpoint path from Azure Files: ${archivePath}`);
    }

    const { accountName, accountKey } = getWorkspaceFilesStorageAccount();
    if (!accountName || !accountKey) {
        throw new Error('Workspace Azure Files storage credentials are required for legacy checkpoint migration');
    }

    if (_workspaceLegacyShareUploadOverride) {
        return await _workspaceLegacyShareUploadOverride({
            entityId,
            workspace,
            archivePath,
            blobPath,
            shareName,
        });
    }

    const {
        ShareServiceClient,
        StorageSharedKeyCredential,
    } = await import('@azure/storage-file-share');
    const credential = new StorageSharedKeyCredential(accountName, accountKey);
    const shareServiceClient = new ShareServiceClient(
        `https://${accountName}.file.core.windows.net`,
        credential,
    );
    const fileClient = shareServiceClient
        .getShareClient(shareName)
        .rootDirectoryClient
        .getFileClient('workspace.tar.gz');

    const fileProperties = await fileClient.getProperties();
    const download = await fileClient.download();
    if (!download.readableStreamBody) {
        throw new Error(`Legacy checkpoint archive is not readable from Azure Files share ${shareName}`);
    }

    const containerClient = await getWorkspaceCheckpointContainerClient();
    const blockBlobClient = containerClient.getBlockBlobClient(blobPath);
    await blockBlobClient.uploadStream(download.readableStreamBody, 4 * 1024 * 1024, 5, {
        blobHTTPHeaders: { blobContentType: 'application/gzip' },
        metadata: workspaceCheckpointBlobMetadata(entityId, {
            checkpointedAt: new Date().toISOString(),
            source: 'legacy-azure-files',
        }),
    });

    return {
        blobPath,
        sizeBytes: fileProperties.contentLength || null,
    };
}

function isFetchTimeoutError(error) {
    const name = error?.name || error?.cause?.name;
    const code = error?.code || error?.cause?.code;
    const message = error?.message || '';
    return name === 'TimeoutError'
        || name === 'AbortError'
        || code === 'ABORT_ERR'
        || code === 'UND_ERR_ABORTED'
        || code === 'UND_ERR_HEADERS_TIMEOUT'
        || /aborted due to timeout|operation was aborted|timeout/i.test(message);
}

async function uploadWorkspaceArchiveFromContainer(entityId, workspace, archivePath, blobPath, timeoutMs, options = {}) {
    const archiveUrl = await createWorkspaceCheckpointWriteUrl(blobPath, options);
    const metadata = {
        ...workspaceCheckpointBlobMetadata(entityId),
        checkpointedAt: new Date().toISOString(),
    };

    const uploadFromWorkspace = async (currentWorkspace) => fetch(`${currentWorkspace.url}/upload-url`, {
        method: 'POST',
        headers: {
            'x-workspace-secret': currentWorkspace.secret,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ archiveUrl, archivePath, metadata }),
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: getLongFetchDispatcher(timeoutMs),
    });

    const retryUploadWithFreshWorkspace = async (reason, { recoverAuth = false } = {}) => {
        const freshConfig = await loadEntityConfig(entityId, { fresh: true });
        let retryWorkspace = freshConfig?.workspace || workspace;
        if (recoverAuth && retryWorkspace?.bootstrapSecret && retryWorkspace?.url) {
            const recoveredConfig = await recoverWorkspaceAuthWithBootstrapSecret(entityId, freshConfig || { workspace: retryWorkspace });
            retryWorkspace = recoveredConfig?.workspace || retryWorkspace;
        }
        if (!retryWorkspace?.url || !retryWorkspace?.secret) return null;

        logger.warn(`Retrying workspace checkpoint upload for ${entityId} after /upload-url ${reason}`);
        return await uploadFromWorkspace(retryWorkspace);
    };

    let uploadResponse;
    try {
        uploadResponse = await uploadFromWorkspace(workspace);
    } catch (e) {
        if (isFetchTimeoutError(e)) {
            throw new Error(`/upload-url timed out after ${Math.round(timeoutMs / 1000)}s`);
        }
        const legacyUpload = await uploadWorkspaceArchiveFromLegacyShare(entityId, workspace, archivePath, blobPath);
        if (legacyUpload) {
            logger.info(`Copied legacy Azure Files checkpoint for ${entityId} directly to Blob after /upload-url failed: ${e.message}`);
            return legacyUpload;
        }
        uploadResponse = await retryUploadWithFreshWorkspace(`fetch failed: ${e.message}`);
    }
    if (!uploadResponse) {
        throw new Error('/upload-url failed and no workspace retry target is available');
    }

    let uploadBody = await uploadResponse.json().catch(() => ({}));
    if (uploadResponse.status === 401) {
        uploadResponse = await retryUploadWithFreshWorkspace(`returned 401: ${uploadBody.error || uploadResponse.statusText}`, {
            recoverAuth: true,
        });
        if (!uploadResponse) {
            throw new Error(`/upload-url returned 401: ${uploadBody.error || 'workspace auth recovery unavailable'}`);
        }
        uploadBody = await uploadResponse.json().catch(() => ({}));
    }

    if (!uploadResponse.ok || uploadBody.error) {
        const isOldWorkspaceImage = uploadResponse.status === 404;
        if (!isOldWorkspaceImage) {
            throw new Error(`/upload-url returned ${uploadResponse.status}: ${uploadBody.error || uploadResponse.statusText}`);
        }

        const legacyUpload = await uploadWorkspaceArchiveFromLegacyShare(entityId, workspace, archivePath, blobPath);
        if (legacyUpload) {
            logger.info(`Copied legacy Azure Files checkpoint for ${entityId} directly to Blob`);
            return legacyUpload;
        }
        throw new Error('Workspace image does not support /upload-url and no legacy Azure Files share is available for checkpoint upload');
    }

    return {
        blobPath,
        sizeBytes: uploadBody.sizeBytes || null,
    };
}

async function uploadStreamingWorkspaceCheckpointFromContainer(entityId, entityConfig, workspace, blobPath, timeoutMs, options = {}) {
    const archiveUrl = await createWorkspaceCheckpointWriteUrl(blobPath, options);
    const encryption = await getOrCreateWorkspaceCheckpointEncryptionKey(entityId, entityConfig);
    const checkpointedAt = options.checkpointedAt || new Date().toISOString();
    const metadata = {
        ...workspaceCheckpointBlobMetadata(entityId),
        checkpointedAt,
        checkpointEncrypted: 'true',
        checkpointEncryptionAlgorithm: encryption.algorithm,
        checkpointEncryptionKeyId: encryption.keyId,
    };

    const uploadFromWorkspace = async (currentWorkspace) => fetch(`${currentWorkspace.url}/backup-upload-url`, {
        method: 'POST',
        headers: {
            'x-workspace-secret': currentWorkspace.secret,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            archiveUrl,
            metadata,
            encryption: {
                algorithm: encryption.algorithm,
                keyBase64: encryption.keyBase64,
                keyId: encryption.keyId,
            },
        }),
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: getLongFetchDispatcher(timeoutMs),
    });

    const retryUploadWithFreshWorkspace = async (reason, { recoverAuth = false } = {}) => {
        const freshConfig = await loadEntityConfig(entityId, { fresh: true });
        let retryWorkspace = freshConfig?.workspace || workspace;
        if (recoverAuth && retryWorkspace?.bootstrapSecret && retryWorkspace?.url) {
            const recoveredConfig = await recoverWorkspaceAuthWithBootstrapSecret(entityId, freshConfig || { workspace: retryWorkspace });
            retryWorkspace = recoveredConfig?.workspace || retryWorkspace;
        }
        if (!retryWorkspace?.url || !retryWorkspace?.secret) return null;

        logger.warn(`Retrying encrypted workspace checkpoint upload for ${entityId} after /backup-upload-url ${reason}`);
        return await uploadFromWorkspace(retryWorkspace);
    };

    let uploadResponse;
    try {
        uploadResponse = await uploadFromWorkspace(workspace);
    } catch (e) {
        if (isFetchTimeoutError(e)) {
            throw new Error(`/backup-upload-url timed out after ${Math.round(timeoutMs / 1000)}s`);
        }
        uploadResponse = await retryUploadWithFreshWorkspace(`fetch failed: ${e.message}`);
    }
    if (!uploadResponse) {
        throw new Error('/backup-upload-url failed and no workspace retry target is available');
    }

    let uploadBody = await uploadResponse.json().catch(() => ({}));
    if (uploadResponse.status === 401) {
        uploadResponse = await retryUploadWithFreshWorkspace(`returned 401: ${uploadBody.error || uploadResponse.statusText}`, {
            recoverAuth: true,
        });
        if (!uploadResponse) {
            throw new Error(`/backup-upload-url returned 401: ${uploadBody.error || 'workspace auth recovery unavailable'}`);
        }
        uploadBody = await uploadResponse.json().catch(() => ({}));
    }

    if (uploadResponse.status === 404) {
        return { unsupported: true };
    }
    if (!uploadResponse.ok || uploadBody.error) {
        throw new Error(`/backup-upload-url returned ${uploadResponse.status}: ${uploadBody.error || uploadResponse.statusText}`);
    }
    if (!uploadBody.encrypted || !uploadBody.encryption?.ivBase64 || !uploadBody.encryption?.tagBase64) {
        throw new Error('/backup-upload-url did not return checkpoint encryption metadata');
    }

    return {
        blobPath,
        sizeBytes: uploadBody.sizeBytes || null,
        durationMs: uploadBody.durationMs || null,
        encryption: {
            algorithm: uploadBody.encryption.algorithm || encryption.algorithm,
            keyId: uploadBody.encryption.keyId || encryption.keyId,
            ivBase64: uploadBody.encryption.ivBase64,
            tagBase64: uploadBody.encryption.tagBase64,
            compression: uploadBody.encryption.compression || uploadBody.compression || 'gzip',
        },
        entityConfig: encryption.entityConfig,
        timestamp: checkpointedAt,
    };
}

async function uploadWorkspaceCheckpoint(entityId, workspace, backupBody, timeoutMs, options = {}) {
    const checkpointBlobPath = workspaceCheckpointBlobPath(entityId);
    if (!backupBody) {
        const previousBlobPath = workspaceCheckpointBlobPath(entityId, 'workspace.prev.tar.gz');
        let copiedPrevious = false;
        try {
            copiedPrevious = await copyExistingWorkspaceCheckpointToPrevious(entityId, checkpointBlobPath, previousBlobPath, options);
        } catch (e) {
            logger.warn(`Failed to copy previous workspace checkpoint for ${entityId}: ${e.message}`);
        }
        const checkpointedAt = new Date().toISOString();
        const streamingUpload = await uploadStreamingWorkspaceCheckpointFromContainer(
            entityId,
            options.entityConfig || { id: entityId, workspace },
            workspace,
            checkpointBlobPath,
            timeoutMs,
            { ...options, checkpointedAt },
        );
        if (streamingUpload.unsupported) {
            return { unsupported: true };
        }
        return {
            path: WORKSPACE_CHECKPOINT_PATH,
            blobPath: streamingUpload.blobPath,
            previousBlobPath: copiedPrevious ? previousBlobPath : null,
            sizeBytes: streamingUpload.sizeBytes,
            sizeMB: streamingUpload.sizeBytes
                ? Math.round(streamingUpload.sizeBytes / 1024 / 1024 * 100) / 100
                : null,
            timestamp: streamingUpload.timestamp || checkpointedAt,
            durationMs: streamingUpload.durationMs || null,
            encryption: streamingUpload.encryption,
            compression: streamingUpload.encryption?.compression || null,
            entityConfig: streamingUpload.entityConfig,
        };
    }
    const checkpointUpload = await uploadWorkspaceArchiveFromContainer(
        entityId,
        workspace,
        backupBody.path || WORKSPACE_CHECKPOINT_PATH,
        checkpointBlobPath,
        timeoutMs,
        options,
    );

    let previousBlobPath = null;
    if (backupBody.previousPath) {
        try {
            previousBlobPath = workspaceCheckpointBlobPath(entityId, 'workspace.prev.tar.gz');
            await uploadWorkspaceArchiveFromContainer(
                entityId,
                workspace,
                backupBody.previousPath,
                previousBlobPath,
                timeoutMs,
                options,
            );
        } catch (e) {
            logger.warn(`Failed to upload previous workspace checkpoint for ${entityId}: ${e.message}`);
            previousBlobPath = null;
        }
    }

    return {
        path: backupBody.path || WORKSPACE_CHECKPOINT_PATH,
        blobPath: checkpointUpload.blobPath,
        previousBlobPath,
        sizeBytes: checkpointUpload.sizeBytes || backupBody.sizeBytes || null,
        sizeMB: backupBody.sizeMB || (
            checkpointUpload.sizeBytes
                ? Math.round(checkpointUpload.sizeBytes / 1024 / 1024 * 100) / 100
                : null
        ),
        timestamp: backupBody.timestamp || new Date().toISOString(),
        durationMs: backupBody.durationMs || null,
    };
}

function workspaceCheckpointFields(checkpoint) {
    if (!checkpoint?.blobPath) return null;
    const checkpointedAtMs = parseTimestampMs(checkpoint.timestamp) || Date.now();
    const fields = {
        checkpointBlobPath: checkpoint.blobPath,
        checkpointPreviousBlobPath: checkpoint.previousBlobPath || null,
        checkpointSizeBytes: checkpoint.sizeBytes || null,
        checkpointSizeMB: checkpoint.sizeMB || null,
        checkpointedAt: new Date(checkpointedAtMs).toISOString(),
    };
    if (checkpoint.encryption) {
        fields.checkpointEncryption = checkpoint.encryption;
    }
    if (checkpoint.compression || checkpoint.encryption?.compression) {
        fields.checkpointCompression = checkpoint.compression || checkpoint.encryption.compression;
    }
    return fields;
}

async function persistWorkspaceCheckpoint(entityId, entityConfig, checkpoint, options = {}) {
    const fields = workspaceCheckpointFields(checkpoint);
    if (!fields) return entityConfig;

    const current = (await loadEntityConfig(entityId, { fresh: true })) || entityConfig;
    if (!current?.workspace) return current;

    const nextWorkspace = {
        ...current.workspace,
        ...fields,
    };
    if (options.clearShareName) {
        delete nextWorkspace.shareName;
    }
    if (options.legacyShareName) {
        nextWorkspace.legacyShareName = options.legacyShareName;
    }

    const updated = {
        ...current,
        workspace: nextWorkspace,
    };
    await getEntityStore().upsertEntity(updated);
    return updated;
}

async function markWorkspaceCheckpointFresh(entityId, entityConfig, timestamp = new Date().toISOString()) {
    const current = (await loadEntityConfig(entityId, { fresh: true })) || entityConfig;
    if (!current?.workspace?.checkpointBlobPath) return current;

    const updated = {
        ...current,
        workspace: {
            ...current.workspace,
            checkpointedAt: timestamp,
        },
    };
    await getEntityStore().upsertEntity(updated);
    return updated;
}

async function checkpointAndPersistWorkspace(entityId, entityConfig, options = {}) {
    const checkpointResult = await checkpointWorkspace(entityId, entityConfig, options);
    if (!checkpointResult.success || checkpointResult.skipped || !checkpointResult.checkpoint?.blobPath) {
        return checkpointResult;
    }

    const updatedEntityConfig = await persistWorkspaceCheckpoint(
        entityId,
        entityConfig,
        checkpointResult.checkpoint,
        options,
    );
    return {
        ...checkpointResult,
        entityConfig: updatedEntityConfig,
    };
}

async function recoverWorkspaceAuthWithBootstrapSecret(entityId, entityConfig) {
    let workspace = entityConfig?.workspace;
    if (!workspace?.bootstrapSecret || !workspace?.url) return null;

    logger.warn(`Workspace auth failed for ${entityId} — attempting reconfigure with bootstrap secret`);
    const backend = await getBackend();
    await reconfigureForEntity(entityId, entityConfig, {
        containerName: workspace.containerId,
        shareName: workspace.shareName || null,
        legacyShareName: workspace.legacyShareName || null,
        url: workspace.url,
        bootstrapSecret: workspace.bootstrapSecret,
        containerId: workspace.containerId,
        claimedFromPool: workspace.claimedFromPool,
    }, backend, { destroyOnFailure: false });

    return await loadEntityConfig(entityId, { fresh: true });
}

async function fetchWorkspaceJson(url, secret, endpoint, options = {}) {
    const timeoutMs = options.timeoutMs || 30000;
    let response;
    try {
        response = await fetch(`${url}${endpoint}`, {
            method: options.method || 'GET',
            headers: {
                'x-workspace-secret': secret,
                'Content-Type': 'application/json',
            },
            ...(options.body ? { body: JSON.stringify(options.body) } : {}),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (e) {
        throw new Error(`${endpoint} fetch failed: ${e.message}`);
    }
    const body = await response.json().catch(() => ({}));
    return { response, body };
}

async function fetchWorkspaceJsonWithAuthRecovery(entityId, entityConfig, endpoint, options = {}) {
    let currentConfig = entityConfig;
    let workspace = currentConfig?.workspace;
    if (!workspace?.url || !workspace?.secret) {
        throw new Error(`${endpoint} fetch failed: workspace URL or secret is missing`);
    }

    let result = await fetchWorkspaceJson(workspace.url, workspace.secret, endpoint, options);
    if (result.response.status !== 401 || !workspace.bootstrapSecret || !entityId) {
        return {
            ...result,
            entityConfig: currentConfig,
            workspace,
            authRecovered: false,
        };
    }

    const recoveredConfig = await recoverWorkspaceAuthWithBootstrapSecret(entityId, currentConfig);
    if (!recoveredConfig?.workspace?.url || !recoveredConfig?.workspace?.secret) {
        return {
            ...result,
            entityConfig: currentConfig,
            workspace,
            authRecovered: false,
        };
    }

    currentConfig = recoveredConfig;
    workspace = recoveredConfig.workspace;
    result = await fetchWorkspaceJson(workspace.url, workspace.secret, endpoint, options);
    return {
        ...result,
        entityConfig: currentConfig,
        workspace,
        authRecovered: true,
    };
}

async function checkpointWorkspace(entityId, entityConfig, options = {}) {
    let workspace = entityConfig?.workspace;
    if (!workspace?.url || !workspace?.secret) {
        return { success: false, error: 'Workspace URL or secret is missing' };
    }

    const timeoutMs = options.timeoutMs || 900000;
    const onWorkspaceLifecycle = typeof options.onWorkspaceLifecycle === 'function'
        ? options.onWorkspaceLifecycle
        : null;
    let activePhase = null;
    const startPhase = async (phase, message) => {
        activePhase = phase;
        await emitWorkspaceLifecycle(onWorkspaceLifecycle, { type: 'start', phase, message });
    };
    const finishPhase = async (success, error = null) => {
        if (!activePhase) return;
        await emitWorkspaceLifecycle(onWorkspaceLifecycle, { type: 'finish', phase: activePhase, success, error });
        activePhase = null;
    };
    try {
        let healthResult = await fetchWorkspaceJsonWithAuthRecovery(entityId, entityConfig, '/health', {
            timeoutMs: Math.min(timeoutMs, 30000),
        });
        entityConfig = healthResult.entityConfig;
        workspace = healthResult.workspace;
        const { response: healthResponse, body: healthBody } = healthResult;
        if (!healthResponse.ok) {
            return { success: false, error: `/health returned ${healthResponse.status}: ${healthBody.error || healthResponse.statusText}` };
        }

        let statusResult = await fetchWorkspaceJsonWithAuthRecovery(entityId, entityConfig, '/status', {
            timeoutMs: Math.min(timeoutMs, 30000),
        });
        entityConfig = statusResult.entityConfig;
        workspace = statusResult.workspace;
        const { response: statusResponse, body: statusBody } = statusResult;
        if (!statusResponse.ok) {
            return { success: false, error: `/status returned ${statusResponse.status}: ${statusBody.error || statusResponse.statusText}` };
        }
        const workspaceVersion = healthBody.version || statusBody.version;
        if (!isPersistentCheckpointWorkspace(workspaceVersion)) {
            return {
                success: true,
                skipped: true,
                reason: `workspace version ${workspaceVersion || 'unknown'} stores files directly on Azure Files`,
            };
        }

        const uploadCheckpoint = options.uploadCheckpoint || _workspaceCheckpointUploadOverride || uploadWorkspaceCheckpoint;
        const canUseStreamingCheckpoint = uploadCheckpoint === uploadWorkspaceCheckpoint
            && isEncryptedStreamingCheckpointWorkspace(workspaceVersion);
        if (canUseStreamingCheckpoint) {
            await startPhase('checkpointUpload', 'Backing up and saving workspace');
            const checkpoint = await uploadCheckpoint(entityId, workspace, null, timeoutMs, {
                ...options,
                entityConfig,
            });
            if (!checkpoint?.unsupported) {
                await finishPhase(true);
                return { success: true, checkpoint };
            }
            await finishPhase(true);
            logger.info(`Workspace image for ${entityId} does not support /backup-upload-url; falling back to two-step checkpoint upload`);
        }

        await startPhase('checkpointBackup', 'Backing up workspace');
        const backupResult = await fetchWorkspaceJsonWithAuthRecovery(entityId, entityConfig, '/backup', {
            method: 'POST',
            timeoutMs,
        });
        entityConfig = backupResult.entityConfig;
        workspace = backupResult.workspace;
        const { response, body } = backupResult;
        if (!response.ok) {
            await finishPhase(false, `/backup returned ${response.status}: ${body.error || response.statusText}`);
            return { success: false, error: `/backup returned ${response.status}: ${body.error || response.statusText}` };
        }
        if (body.error) {
            await finishPhase(false, body.error);
            return { success: false, error: body.error };
        }
        await finishPhase(true);

        await startPhase('checkpointUpload', 'Saving workspace backup');
        const checkpoint = await uploadCheckpoint(entityId, workspace, body, timeoutMs, options);
        await finishPhase(true);
        return { success: true, checkpoint };
    } catch (e) {
        await finishPhase(false, e.message);
        return { success: false, error: `Checkpoint failed: ${e.message}` };
    }
}

function isPersistentCheckpointWorkspace(version) {
    if (typeof version !== 'string') return false;
    const parts = version.split('.').map(part => Number.parseInt(part, 10));
    if (parts.some(Number.isNaN)) return false;
    const [major = 0, minor = 0, patch = 0] = parts;
    if (major !== 1) return major > 1;
    if (minor !== 0) return minor > 0;
    return patch >= 3;
}

function isEncryptedStreamingCheckpointWorkspace(version) {
    if (typeof version !== 'string') return false;
    const parts = version.split('.').map(part => Number.parseInt(part, 10));
    if (parts.some(Number.isNaN)) return false;
    const [major = 0, minor = 0, patch = 0] = parts;
    if (major !== 1) return major > 1;
    if (minor !== 0) return minor > 0;
    return patch >= 10;
}

function getWorkspaceTransitionWaitMs(options = {}) {
    const waitMs = Number(options.transitionWaitMs);
    return Number.isFinite(waitMs) && waitMs >= 0
        ? waitMs
        : WORKSPACE_TRANSITION_WAIT_MS;
}

function getWorkspaceTransitionPollMs(options = {}) {
    const pollMs = Number(options.transitionPollMs);
    return Number.isFinite(pollMs) && pollMs >= 0
        ? pollMs
        : WORKSPACE_TRANSITION_POLL_MS;
}

function workspaceTransitionLifecycle(status) {
    if (status === 'starting') {
        return { phase: 'wake', message: 'Waiting for workspace to start' };
    }
    return { phase: 'provision', message: 'Waiting for workspace setup' };
}

async function waitForWorkspaceTransition(entityId, options = {}) {
    const deadline = Date.now() + getWorkspaceTransitionWaitMs(options);
    const pollMs = getWorkspaceTransitionPollMs(options);

    while (Date.now() < deadline) {
        await sleep(Math.min(pollMs, Math.max(deadline - Date.now(), 0)));
        const entityConfig = await loadEntityConfig(entityId, { fresh: true });
        if (!entityConfig) {
            return { success: false, error: 'Entity not found' };
        }

        const workspace = entityConfig.workspace;
        if (workspace?.status === 'running' && workspace.url) {
            return { success: true, entityConfig };
        }
        if (workspace?.status === 'error') {
            return { success: false, error: 'Workspace provisioning failed' };
        }
        if (workspace?.status && !WORKSPACE_TRANSITION_STATUSES.has(workspace.status)) {
            return { success: true, entityConfig };
        }
    }

    return { success: false, error: 'Workspace is still provisioning, please retry shortly' };
}

async function ensureWorkspaceReady(entityId, options = {}) {
    if (!isValidWorkspaceEntityId(entityId)) {
        logger.warn('Workspace readiness skipped: missing entityId');
        return invalidWorkspaceEntityResult();
    }

    const onWorkspaceLifecycle = typeof options.onWorkspaceLifecycle === 'function'
        ? options.onWorkspaceLifecycle
        : null;
    const waitForTransition = options.waitForTransition !== false;

    let entityConfig = await loadEntityConfig(entityId);
    if (!entityConfig) {
        return { success: false, error: 'Entity not found' };
    }

    // Recover from stale transitional states ('starting', 'provisioning').
    // If stuck for >5 min, mark as error to trigger re-provision.
    const ws = entityConfig.workspace;
    if (ws && WORKSPACE_TRANSITION_STATUSES.has(ws.status)) {
        const transitionStartedAt = ws.provisionedAt ? new Date(ws.provisionedAt).getTime() : NaN;
        const staleMs = Number.isFinite(transitionStartedAt)
            ? Date.now() - transitionStartedAt
            : Infinity;
        if (staleMs > 5 * 60 * 1000) {
            logger.warn(`Workspace for ${entityId} stuck in '${ws.status}' — marking as error`);
            try {
                await getEntityStore().upsertEntity({ ...entityConfig, workspace: { ...ws, status: 'error' } });
            } catch { /* best effort */ }
            entityConfig = await loadEntityConfig(entityId);
        } else if (waitForTransition) {
            const lifecycle = workspaceTransitionLifecycle(ws.status);
            await emitWorkspaceLifecycle(onWorkspaceLifecycle, {
                type: 'start',
                phase: lifecycle.phase,
                message: lifecycle.message,
            });
            const transitionResult = await waitForWorkspaceTransition(entityId, options);
            await emitWorkspaceLifecycle(onWorkspaceLifecycle, {
                type: 'finish',
                phase: lifecycle.phase,
                success: transitionResult.success,
                error: transitionResult.error,
            });
            if (!transitionResult.success) {
                return transitionResult;
            }
            entityConfig = transitionResult.entityConfig;
        } else {
            return { success: false, error: `Workspace is ${ws.status}, please retry shortly` };
        }
    }

    // Auto-provision if workspace not configured or in error state
    if (!entityConfig.workspace || !entityConfig.workspace.url || entityConfig.workspace.status === 'error') {
        await emitWorkspaceLifecycle(onWorkspaceLifecycle, { type: 'start', phase: 'provision', message: 'Setting up workspace' });
        const provisionResult = await provisionWorkspace(entityId, entityConfig, options);
        await emitWorkspaceLifecycle(onWorkspaceLifecycle, {
            type: 'finish',
            phase: 'provision',
            success: provisionResult.success,
            error: provisionResult.error,
        });
        if (!provisionResult.success) {
            return { success: false, error: provisionResult.error };
        }
        // Reload entity config after provisioning
        entityConfig = await loadEntityConfig(entityId);
        if (!entityConfig?.workspace?.url) {
            return { success: false, error: 'Workspace provisioning completed but config not available' };
        }
        // Seed activity timestamp so the idle reaper can see this workspace
        // even if the provisioning request does not make a follow-up workspaceRequest().
        recordWorkspaceActivity(entityId);
        if (provisionResult.checkpointRestored) {
            entityConfig = await markWorkspaceCheckpointFresh(entityId, entityConfig);
        }
    }

    // Wake stopped workspace on demand — much faster than full re-provision
    if (entityConfig.workspace.status === 'stopped' && entityConfig.workspace.containerId) {
        await emitWorkspaceLifecycle(onWorkspaceLifecycle, { type: 'start', phase: 'wake', message: 'Starting workspace' });
        const wakeResult = await wakeWorkspace(entityId, entityConfig);
        await emitWorkspaceLifecycle(onWorkspaceLifecycle, {
            type: 'finish',
            phase: 'wake',
            success: wakeResult.success,
            error: wakeResult.error,
        });
        if (!wakeResult.success) {
            return { success: false, error: wakeResult.error };
        }
        entityConfig = await loadEntityConfig(entityId);
        if (!entityConfig?.workspace?.url) {
            return { success: false, error: 'Workspace wake completed but config not available' };
        }
        recordWorkspaceActivity(entityId);
    }

    // Reprovision if workspace image is outdated
    const expectedVersion = config.get('workspaceImageVersion');
    if (expectedVersion && entityConfig.workspace.imageVersion &&
        entityConfig.workspace.imageVersion !== expectedVersion) {
        logger.info(`Workspace for ${entityId} has stale image (${entityConfig.workspace.imageVersion} vs ${expectedVersion}) — reprovisioning`);
        const reprovisionResult = await reprovisionStaleWorkspace(entityId, entityConfig, options, onWorkspaceLifecycle);
        if (!reprovisionResult.success) {
            return { success: false, error: reprovisionResult.error };
        }
        entityConfig = reprovisionResult.entityConfig || await loadEntityConfig(entityId);
        if (!entityConfig?.workspace?.url) {
            return { success: false, error: 'Workspace re-provision completed but config not available' };
        }
        recordWorkspaceActivity(entityId);
        if (reprovisionResult.checkpointRestored) {
            entityConfig = await markWorkspaceCheckpointFresh(entityId, entityConfig);
        }
    }

    return { success: true, entityConfig };
}

async function reprovisionStaleWorkspace(entityId, entityConfig, options, onWorkspaceLifecycle) {
    if (reprovisionLocks.has(entityId)) {
        await reprovisionLocks.get(entityId);
        const nextEntityConfig = await loadEntityConfig(entityId, { fresh: true });
        const expectedVersion = config.get('workspaceImageVersion');
        if (!expectedVersion || nextEntityConfig?.workspace?.imageVersion === expectedVersion) {
            return { success: true, entityConfig: nextEntityConfig };
        }
        return { success: false, error: 'Concurrent workspace re-provision did not update the workspace image' };
    }

    const reprovisionPromise = (async () => {
        await emitWorkspaceLifecycle(onWorkspaceLifecycle, { type: 'start', phase: 'reprovision', message: 'Updating workspace' });
        const destroyResult = await destroyWorkspace(entityId, entityConfig, { onWorkspaceLifecycle });
        if (!destroyResult.success) {
            await emitWorkspaceLifecycle(onWorkspaceLifecycle, {
                type: 'finish',
                phase: 'reprovision',
                success: false,
                error: destroyResult.error,
            });
            return { success: false, error: destroyResult.error };
        }

        // destroyWorkspace preserves a Blob checkpoint in entity config, so
        // provisionWorkspace can restore it into a warm or fresh container.
        const provisionResult = await provisionWorkspace(entityId, await loadEntityConfig(entityId), options);
        await emitWorkspaceLifecycle(onWorkspaceLifecycle, {
            type: 'finish',
            phase: 'reprovision',
            success: provisionResult.success,
            error: provisionResult.error,
        });
        if (!provisionResult.success) {
            return { success: false, error: provisionResult.error };
        }
        return {
            success: true,
            entityConfig: await loadEntityConfig(entityId),
            checkpointRestored: Boolean(provisionResult.checkpointRestored),
        };
    })();

    reprovisionLocks.set(entityId, reprovisionPromise);
    try {
        return await reprovisionPromise;
    } finally {
        reprovisionLocks.delete(entityId);
    }
}

async function restoreWorkspaceCheckpointToContainer(entityId, entityConfig, container, options = {}) {
    const checkpointBlobPath = entityConfig?.workspace?.checkpointBlobPath;
    if (!checkpointBlobPath) {
        return { success: true, skipped: true, reason: 'no checkpoint blob' };
    }

    const timeoutMs = options.timeoutMs || 900000;
    const onWorkspaceLifecycle = typeof options.onWorkspaceLifecycle === 'function'
        ? options.onWorkspaceLifecycle
        : null;
    const checkpointUrl = await createWorkspaceCheckpointReadUrl(checkpointBlobPath, {
        ...options,
        entityId,
    });
    const checkpointEncryption = buildWorkspaceCheckpointRestoreEncryption(entityConfig);

    await emitWorkspaceLifecycle(onWorkspaceLifecycle, { type: 'start', phase: 'restore', message: 'Restoring workspace backup' });
    try {
        const directResponse = await fetch(`${container.url}/restore-url`, {
            method: 'POST',
            headers: {
                'x-workspace-secret': container.bootstrapSecret,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                archiveUrl: checkpointUrl,
                archivePath: WORKSPACE_CHECKPOINT_PATH,
                ...(checkpointEncryption ? { encryption: checkpointEncryption } : {}),
            }),
            signal: AbortSignal.timeout(timeoutMs),
            dispatcher: getLongFetchDispatcher(timeoutMs),
        });
        const directBody = await directResponse.json().catch(() => ({}));
        let restoreBody = directBody;
        if (!directResponse.ok || directBody.error) {
            const isOldWorkspaceImage = directResponse.status === 404;
            if (!isOldWorkspaceImage) {
                throw new Error(`/restore-url returned ${directResponse.status}: ${directBody.error || directResponse.statusText}`);
            }
            if (checkpointEncryption) {
                throw new Error('encrypted checkpoint restore requires workspace image support for /restore-url encryption');
            }

            logger.info(`Workspace image for ${entityId} does not support /restore-url; falling back to direct shell download`);
            const downloadScript = `
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
(async () => {
  const url = process.env.WORKSPACE_RESTORE_URL;
  const out = process.env.WORKSPACE_RESTORE_PATH;
  const tmp = out + '.download';
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error('download failed: ' + response.status + ' ' + response.statusText);
  await fs.promises.mkdir(path.dirname(out), { recursive: true });
  await fs.promises.rm(tmp, { force: true });
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tmp));
  await fs.promises.rename(tmp, out);
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
`;
            const downloadCommand = [
                `WORKSPACE_RESTORE_URL=${shellQuote(checkpointUrl)}`,
                `WORKSPACE_RESTORE_PATH=${shellQuote(WORKSPACE_CHECKPOINT_PATH)}`,
                'node -e',
                shellQuote(downloadScript),
            ].join(' ');

            const shellResponse = await fetch(`${container.url}/shell`, {
                method: 'POST',
                headers: {
                    'x-workspace-secret': container.bootstrapSecret,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ command: downloadCommand, timeout: timeoutMs }),
                signal: AbortSignal.timeout(timeoutMs),
                dispatcher: getLongFetchDispatcher(timeoutMs),
            });
            const shellBody = await shellResponse.json().catch(() => ({}));
            if (!shellResponse.ok || shellBody.error || shellBody.exitCode) {
                throw new Error(`/shell checkpoint download returned ${shellResponse.status}: ${shellBody.error || shellBody.stderr || shellResponse.statusText}`);
            }

            restoreBody = await restoreWorkspaceArchiveInContainer(container, WORKSPACE_CHECKPOINT_PATH, timeoutMs);
        }

        await emitWorkspaceLifecycle(onWorkspaceLifecycle, { type: 'finish', phase: 'restore', success: true });
        logger.info(`Restored workspace checkpoint for ${entityId} from ${checkpointBlobPath}`);
        return {
            success: true,
            checkpointBlobPath,
            sizeBytes: restoreBody.sizeBytes || entityConfig.workspace.checkpointSizeBytes || null,
        };
    } catch (e) {
        await emitWorkspaceLifecycle(onWorkspaceLifecycle, { type: 'finish', phase: 'restore', success: false, error: e.message });
        throw e;
    }
}

async function restoreWorkspaceArchiveInContainer(container, archivePath, timeoutMs = 900000) {
    const response = await fetch(`${container.url}/restore`, {
        method: 'POST',
        headers: {
            'x-workspace-secret': container.bootstrapSecret,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ archivePath }),
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: getLongFetchDispatcher(timeoutMs),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.error) {
        throw new Error(`/restore returned ${response.status}: ${body.error || response.statusText}`);
    }
    return body;
}

async function workspaceArchiveExistsInContainer(container, archivePath, timeoutMs = 30000) {
    const response = await fetch(`${container.url}/shell`, {
        method: 'POST',
        headers: {
            'x-workspace-secret': container.bootstrapSecret,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            command: `test -f ${shellQuote(archivePath)}`,
            timeout: timeoutMs,
        }),
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher: getLongFetchDispatcher(timeoutMs),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || (body.error && body.exitCode == null)) {
        throw new Error(`/shell archive check returned ${response.status}: ${body.error || response.statusText}`);
    }
    return Number(body.exitCode || 0) === 0;
}

async function restoreLegacyShareArchiveToContainer(entityId, entityConfig, container) {
    const legacyShareName = container.legacyShareName;
    if (!legacyShareName || entityConfig?.workspace?.checkpointBlobPath) {
        return { success: true, skipped: true, reason: 'no legacy share archive' };
    }

    if (!await workspaceArchiveExistsInContainer(container, WORKSPACE_CHECKPOINT_PATH)) {
        return { success: true, skipped: true, reason: 'legacy share has no checkpoint archive' };
    }

    const body = await restoreWorkspaceArchiveInContainer(container, WORKSPACE_CHECKPOINT_PATH);
    logger.info(`Restored legacy Azure Files checkpoint for ${entityId} from share ${legacyShareName}`);
    return {
        success: true,
        legacyShareName,
        sizeBytes: body.sizeBytes || null,
    };
}

async function checkpointLegacyShareAfterProvision(entityId, entityConfig) {
    const legacyShareName = getLegacyShareName(entityConfig?.workspace);
    if (legacyShareName) {
        try {
            const checkpointBlobPath = workspaceCheckpointBlobPath(entityId);
            const checkpointUpload = await uploadWorkspaceArchiveFromLegacyShare(
                entityId,
                { legacyShareName },
                WORKSPACE_CHECKPOINT_PATH,
                checkpointBlobPath,
            );
            if (checkpointUpload?.blobPath) {
                logger.info(`Copied legacy Azure Files checkpoint for ${entityId} directly to Blob after provision`);
                const checkpoint = {
                    path: WORKSPACE_CHECKPOINT_PATH,
                    blobPath: checkpointUpload.blobPath,
                    previousBlobPath: null,
                    sizeBytes: checkpointUpload.sizeBytes || null,
                    sizeMB: checkpointUpload.sizeBytes
                        ? Math.round(checkpointUpload.sizeBytes / 1024 / 1024 * 100) / 100
                        : null,
                    timestamp: new Date().toISOString(),
                };
                return {
                    success: true,
                    checkpoint,
                    entityConfig: await persistWorkspaceCheckpoint(entityId, entityConfig, checkpoint, {
                        clearShareName: true,
                        legacyShareName,
                    }),
                };
            }
        } catch (e) {
            logger.warn(`Direct legacy workspace checkpoint copy failed for ${entityId}: ${e.message}; falling back to live checkpoint`);
        }
    }

    const freshEntityConfig = await loadEntityConfig(entityId, { fresh: true });
    const checkpointResult = await checkpointAndPersistWorkspace(entityId, freshEntityConfig || entityConfig, {
        clearShareName: true,
        legacyShareName,
    });
    if (!checkpointResult.success) {
        logger.warn(`Legacy workspace share migration checkpoint failed for ${entityId}: ${checkpointResult.error}`);
        return checkpointResult;
    }

    return checkpointResult;
}

async function setupWorkspaceContainerForEntity(entityId, entityConfig, container, backend, options = {}) {
    try {
        let restoreResult = await restoreWorkspaceCheckpointToContainer(entityId, entityConfig, container, options);
        if (restoreResult.skipped) {
            restoreResult = await restoreLegacyShareArchiveToContainer(entityId, entityConfig, container);
        }
        await reconfigureForEntity(entityId, entityConfig, container, backend, {
            forceEnvRewrite: Boolean(restoreResult?.success && !restoreResult.skipped),
        });
        return restoreResult;
    } catch (e) {
        try {
            await backend.remove(container.containerId || container.containerName, container.containerName);
        } catch {
            // Best-effort cleanup. The setup error is the actionable failure.
        }
        throw e;
    }
}

/**
 * Unified provision: claim from pool or create generic container, then reconfigure.
 *
 * Flow:
 *   1. Restore from Blob checkpoint when present
 *   2. claimContainer() — try Redis-backed warm pool (ACI only)
 *   3. createGenericContainer() — create on demand, only mounting Azure Files for one-time legacy migration
 *   4. reconfigureForEntity() — inject secrets, mount blob storage, rotate secret
 */
async function _doProvision(entityId, entityConfig) {
    if (!isValidWorkspaceEntityId(entityId)) {
        throw new Error('Workspace entityId is required');
    }

    const backend = await getBackend();
    entityConfig = await recoverExistingWorkspaceCheckpoint(entityId, entityConfig);

    // Azure Files is now legacy-only. If a Blob checkpoint exists, the entity is
    // warm-pool eligible even when an old share name is still present.
    const checkpointBlobPath = entityConfig?.workspace?.checkpointBlobPath || null;
    const legacyShareName = getLegacyShareName(entityConfig?.workspace);
    const needsLegacyShareMigration = Boolean(legacyShareName && !checkpointBlobPath);

    logger.info(`Provisioning workspace for entity ${entityId} [${backend.backendName} backend]${checkpointBlobPath ? ' (restoring Blob checkpoint)' : needsLegacyShareMigration ? ` (migrating legacy share: ${legacyShareName})` : ''}`);

    try {
        // Update entity status to provisioning (preserve shareName so it's not lost)
        const entityStore = getEntityStore();
        await entityStore.upsertEntity({
            ...entityConfig,
            workspace: {
                ...(entityConfig.workspace || {}),
                status: 'provisioning',
                provisionedAt: new Date(),
            },
        });

        // Step 1: Try to claim a pre-provisioned container from the warm pool.
        // Legacy share-only entities need one generic ACI with the old share
        // mounted so they can self-migrate to Blob checkpoints first.
        let container = null;
        if (!needsLegacyShareMigration && backend.backendName === 'aci' && config.get('warmPoolSize') > 0) {
            const claimed = await claimContainer(entityId);
            if (claimed.success) {
                container = {
                    containerName: claimed.containerName,
                    url: claimed.url,
                    bootstrapSecret: claimed.bootstrapSecret,
                    containerId: claimed.containerId,
                    claimedFromPool: true,
                    imageVersion: claimed.imageVersion || null,
                };
                logger.info(`[WarmPool] Claimed ${container.containerName} for entity ${entityId}`);
            } else {
                logger.info(`[WarmPool] No pool container available for ${entityId}, creating on demand`);
            }
        }

        // Step 2: If no pool container, create a generic one.
        if (!container) {
            container = await createGenericContainer(entityId, backend, {
                shareName: needsLegacyShareMigration ? legacyShareName : null,
                mountAzureFiles: needsLegacyShareMigration,
            });
        }

        let migratedLegacyShare = false;
        let setupResult = null;
        // Step 3/4: Restore any Blob checkpoint before entity env/secrets are
        // written, so restored .env files cannot win over current secrets. If
        // a pool-claimed container is dead, fall back to creating a fresh one.
        try {
            setupResult = await setupWorkspaceContainerForEntity(entityId, entityConfig, container, backend);
        } catch (provisionErr) {
            if (checkpointBlobPath && legacyShareName && backend.backendName === 'aci') {
                logger.warn(`Blob checkpoint restore failed for ${entityId}; falling back to legacy share migration: ${provisionErr.message}`);
                const legacyEntityConfig = {
                    ...entityConfig,
                    workspace: {
                        ...(entityConfig.workspace || {}),
                        checkpointBlobPath: null,
                    },
                };
                container = await createGenericContainer(entityId, backend, {
                    shareName: legacyShareName,
                    mountAzureFiles: true,
                });
                setupResult = await setupWorkspaceContainerForEntity(entityId, legacyEntityConfig, container, backend);
                migratedLegacyShare = true;
            } else if (container.claimedFromPool) {
                logger.warn(`[WarmPool] Claimed container ${container.containerName} failed setup — falling back to fresh container: ${provisionErr.message}`);
                container = await createGenericContainer(entityId, backend);
                setupResult = await setupWorkspaceContainerForEntity(entityId, entityConfig, container, backend);
            } else {
                throw provisionErr;
            }
        }

        if (needsLegacyShareMigration || migratedLegacyShare) {
            await checkpointLegacyShareAfterProvision(entityId, entityConfig);
        }

        logger.info(`Workspace provisioned for entity ${entityId}: ${container.url}`);
        return { success: true, checkpointRestored: Boolean(setupResult?.success && !setupResult.skipped) };
    } catch (e) {
        logger.error(`Failed to provision workspace for entity ${entityId}: ${e.message}`);

        // Mark as error
        try {
            const entityStore = getEntityStore();
            await entityStore.upsertEntity({
                ...entityConfig,
                workspace: {
                    ...(entityConfig.workspace || {}),
                    status: 'error',
                },
            });
        } catch {
            // Best effort
        }

        return { success: false, error: `Provisioning failed: ${e.message}` };
    }
}

/**
 * Create a generic container with minimal setup (no entity secrets, no blob mount).
 * Used when the warm pool is empty or disabled.
 *
 * @param {string} entityId - Entity UUID (used for container naming)
 * @param {Object} backend - Container backend instance
 * @param {Object} [options]
 * @param {string} [options.shareName] - Legacy Azure Files share to mount for one-time migration
 * @param {boolean} [options.mountAzureFiles] - Mount shareName as /persist for legacy migration
 * @returns {Promise<{containerName: string, shareName: string, url: string, bootstrapSecret: string, containerId: string, claimedFromPool: boolean}>}
 */
async function createGenericContainer(entityId, backend, options = {}) {
    if (!isValidWorkspaceEntityId(entityId)) {
        throw new Error('Workspace entityId is required');
    }

    const baseContainerName = workspaceContainerNameForEntity(entityId);
    const requestedShareName = options.shareName || null;
    const shareName = backend.backendName === 'aci'
        ? (options.mountAzureFiles ? requestedShareName : null)
        : (requestedShareName || baseContainerName);
    const mountAzureFiles = Boolean(options.mountAzureFiles && shareName);
    const bootstrapSecret = crypto.randomBytes(32).toString('hex');
    const image = resolveWorkspaceImage();
    const cpus = parseFloat(config.get('workspaceCpus'));
    const memory = config.get('workspaceMemory');
    const diskSize = config.get('workspaceDiskSize');
    const memoryMB = parseMemoryToMB(memory);

    const env = [
        `WORKSPACE_SECRET=${bootstrapSecret}`,
        `PORT=3100`,
    ];

    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        const containerName = buildRuntimeContainerName(baseContainerName, attempt);
        logger.info(`Creating generic container ${containerName} [${backend.backendName}]${mountAzureFiles ? ` (legacy share: ${shareName})` : ''}`);

        let created;
        try {
            created = await backend.createAndStart({
                containerName,
                image,
                env,
                cpus,
                memoryMB,
                diskSize,
                shareName,
                mountAzureFiles,
                tags: {
                    workspaceRole: 'entity',
                    entityId,
                    createdAt: new Date().toISOString(),
                    ...(mountAzureFiles ? { legacyShareName: shareName } : {}),
                },
            });
        } catch (e) {
            lastError = e;
            if (attempt < 2 && isCrossRegionContainerNameConflict(e)) {
                logger.warn(`Container name ${containerName} already exists in another Azure location; retrying with a unique runtime name`);
                continue;
            }
            throw e;
        }

        const healthOk = await waitForHealth(created.url, backend.healthTimeoutMs);
        if (!healthOk) {
            throw new Error('Container failed to become healthy');
        }

        return {
            containerName,
            shareName,
            legacyShareName: mountAzureFiles ? shareName : null,
            url: created.url,
            bootstrapSecret,
            containerId: created.containerId,
            claimedFromPool: false,
            imageVersion: config.get('workspaceImageVersion') || null,
        };
    }

    throw lastError || new Error('Failed to create workspace container');
}

function buildRuntimeContainerName(baseContainerName, attempt) {
    if (attempt === 0) return baseContainerName;
    return `${baseContainerName}-${crypto.randomUUID().replace(/-/g, '').slice(0, 6)}`;
}

function isCrossRegionContainerNameConflict(error) {
    const message = error?.message || '';
    return message.includes('already exists in location')
        && message.includes('same name cannot be created in location');
}

/**
 * Reconfigure a container for a specific entity.
 * Rotates the secret, injects entity secrets, and mounts blob storage.
 * Works for both pool-claimed and freshly-created containers.
 *
 * @param {string} entityId - Entity UUID
 * @param {Object} entityConfig - Current entity config
 * @param {Object} container - Container info from claimContainer or createGenericContainer
 * @param {Object} backend - Container backend instance
 */
async function reconfigureForEntity(entityId, entityConfig, container, backend, options = {}) {
    const { containerName, shareName, legacyShareName, url, bootstrapSecret, containerId, claimedFromPool } = container;
    const { destroyOnFailure = true, forceEnvRewrite = false } = options;
    const newSecret = crypto.randomBytes(32).toString('hex');

    try {
        // Build reconfigure payload
        const reconfigPayload = { secret: newSecret };

        // Decrypt entity secrets for env injection
        const plainSecrets = {};
        if (entityConfig.secrets) {
            const systemKey = config.get('redisEncryptionKey');
            for (const [key, encVal] of Object.entries(entityConfig.secrets)) {
                const val = decrypt(encVal, systemKey);
                if (val) {
                    plainSecrets[key] = val;
                }
            }
        }
        if (Object.keys(plainSecrets).length > 0 || forceEnvRewrite) {
            reconfigPayload.env = plainSecrets;
        }

        // Add blob mount if applicable (ACI backend, private entity with single user)
        if (backend.backendName === 'aci') {
            const blobMount = await buildBlobMountPayload(entityConfig);
            if (blobMount) {
                reconfigPayload.blobMount = blobMount;

                // Also add blob env vars so the workspace knows about them
                if (!reconfigPayload.env) reconfigPayload.env = {};
                reconfigPayload.env.AZURE_STORAGE_ACCOUNT_NAME = blobMount.accountName;
                reconfigPayload.env.AZURE_BLOB_SAS_TOKEN = blobMount.sasToken;
                reconfigPayload.env.AZURE_BLOB_CONTAINER = blobMount.containerName;
            }
        }

        // Call /reconfigure using the bootstrap secret
        const response = await fetch(`${url}/reconfigure`, {
            method: 'POST',
            headers: {
                'x-workspace-secret': bootstrapSecret,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(reconfigPayload),
            signal: AbortSignal.timeout(30000),
        });

        if (!response.ok) {
            const errBody = await response.json().catch(() => ({}));
            throw new Error(`/reconfigure returned ${response.status}: ${errBody.error || response.statusText}`);
        }

        // Update entity config in MongoDB
        // Store bootstrapSecret so wakeWorkspace can re-authenticate after
        // a container restart (the container reverts to its env-var secret).
        const entityStore = getEntityStore();
        const previousWorkspace = entityConfig.workspace || {};
        const nextWorkspace = {
            url,
            secret: newSecret,
            bootstrapSecret,
            containerId: containerId || containerName,
            status: 'running',
            provisionedAt: new Date(),
            claimedFromPool,
            imageVersion: container.imageVersion || config.get('workspaceImageVersion') || null,
            ...getWorkspaceCheckpointMetadata(previousWorkspace),
        };
        if (shareName) {
            nextWorkspace.shareName = shareName;
        }
        const retainedLegacyShareName = legacyShareName || previousWorkspace.legacyShareName || previousWorkspace.shareName || null;
        if (retainedLegacyShareName) {
            nextWorkspace.legacyShareName = retainedLegacyShareName;
        }

        await entityStore.upsertEntity({
            ...entityConfig,
            workspace: nextWorkspace,
        });
    } catch (e) {
        if (destroyOnFailure) {
            // Remove the container on failure — but NEVER destroy the volume.
            // The share may be pre-existing with user data (e.g. during reprovision
            // or auth recovery). Only destroyWorkspace({ destroyVolume: true }) should
            // delete shares, as an explicit user action.
            try {
                await backend.remove(containerId || containerName, containerName);
            } catch {
                // Best-effort cleanup
            }
        }

        throw e;
    }
}

/**
 * Build blob mount payload for /reconfigure.
 * Returns null if blob mount is not applicable (no storage config, or not a single-user entity).
 *
 * @param {Object} entityConfig - Entity config with assocUserIds
 * @returns {Promise<{accountName: string, sasToken: string, containerName: string}|null>}
 */
async function buildBlobMountPayload(entityConfig) {
    const storageAccountName = config.get('azureStorageAccountName');
    const storageAccountKey = config.get('azureStorageAccountKey');
    const blobContainerName = config.get('azureBlobContainerName');
    const assocUserIds = Array.isArray(entityConfig.assocUserIds) ? entityConfig.assocUserIds : [];
    const ownerUserId = assocUserIds.length === 1 ? assocUserIds[0] : null;

    if (!storageAccountName || !storageAccountKey || !blobContainerName || !ownerUserId) {
        return null;
    }

    const userContainer = getUserContainerName(blobContainerName, ownerUserId);
    await ensureContainer(storageAccountName, storageAccountKey, userContainer);
    const sasToken = generateContainerSASToken(storageAccountName, storageAccountKey, userContainer);

    return {
        accountName: storageAccountName,
        sasToken,
        containerName: userContainer,
    };
}

/**
 * Stop and remove a workspace container.
 * When destroyVolume is false (default), a Blob checkpoint is preserved in the
 * entity config so the next provision can restore it into a warm container.
 */
export async function destroyWorkspace(entityId, entityConfig, options = {}) {
    const {
        destroyVolume: shouldDestroyVolume = false,
        skipCheckpoint = false,
        lastActivityAt = null,
        timeoutMs,
    } = options;
    const onWorkspaceLifecycle = typeof options.onWorkspaceLifecycle === 'function'
        ? options.onWorkspaceLifecycle
        : null;
    let workspace = entityConfig?.workspace;
    // Use stored containerId — pool-claimed containers have names like
    // workspace-pool-{shortId}, not workspace-{entityId}.
    const containerName = workspace?.containerId || `workspace-${entityId}`;
    const legacyShareName = getLegacyShareName(workspace);

    try {
        const backend = await getBackend();
        let checkpointResult = null;
        let effectiveLastActivityAt = lastActivityAt;
        if (!effectiveLastActivityAt && !shouldDestroyVolume && !skipCheckpoint && backend.backendName === 'aci' && workspace?.checkpointBlobPath) {
            const latestActivity = await readLatestWorkspaceActivityTimestamp(entityId, 0);
            if (latestActivity.ok) {
                effectiveLastActivityAt = latestActivity.timestamp;
            }
        }
        let checkpointAlreadyFresh = Boolean(
            effectiveLastActivityAt && isWorkspaceCheckpointFresh(workspace, effectiveLastActivityAt)
        );

        if (!shouldDestroyVolume && !skipCheckpoint && backend.backendName === 'aci' && workspace?.url) {
            if (!checkpointAlreadyFresh && workspace?.checkpointBlobPath) {
                try {
                    const recoveredEntityConfig = await recoverFreshWorkspaceCheckpointFromBlob(entityId, entityConfig, effectiveLastActivityAt);
                    if (recoveredEntityConfig?.workspace) {
                        entityConfig = recoveredEntityConfig;
                        workspace = recoveredEntityConfig.workspace;
                        checkpointAlreadyFresh = true;
                        logger.info(`Recovered fresh workspace checkpoint metadata for ${entityId} from Blob before destroy`);
                    }
                } catch (e) {
                    logger.warn(`Could not recover workspace checkpoint metadata from Blob for ${entityId}: ${e.message}`);
                }
            }

            if (checkpointAlreadyFresh) {
                logger.info(`Skipped workspace checkpoint for ${entityId} before destroy: checkpoint is already fresh`);
            } else {
                checkpointResult = await checkpointWorkspace(entityId, entityConfig, { timeoutMs, onWorkspaceLifecycle });
                if (!checkpointResult.success) {
                    logger.warn(`Skipping destroy for ${entityId}; workspace checkpoint failed: ${checkpointResult.error}`);
                    return { success: false, error: checkpointResult.error };
                }
                if (checkpointResult.skipped) {
                    logger.info(`Skipped workspace checkpoint for ${entityId} before destroy: ${checkpointResult.reason}`);
                } else {
                    logger.info(`Checkpointed workspace for ${entityId} before destroy (${checkpointResult.checkpoint?.sizeMB ?? '?'} MB)`);
                }
            }

            if (effectiveLastActivityAt && !checkpointResult?.skipped) {
                const latestActivity = await readLatestWorkspaceActivityTimestamp(entityId, effectiveLastActivityAt);
                if (!latestActivity.ok) {
                    logger.warn(`Skipping destroy for ${entityId}; latest workspace activity could not be verified`);
                    return { success: false, error: 'Latest workspace activity could not be verified' };
                }
                const checkpointedAt = checkpointResult?.checkpoint
                    ? parseTimestampMs(checkpointResult.checkpoint.timestamp)
                    : parseTimestampMs(workspace.checkpointedAt);
                if (!checkpointedAt || checkpointedAt < latestActivity.timestamp) {
                    logger.warn(`Skipping destroy for ${entityId}; workspace changed after the latest checkpoint`);
                    return { success: false, error: 'Workspace checkpoint is stale' };
                }
            }
        }

        if (shouldDestroyVolume) {
            const checkpointDeleteResult = await deleteWorkspaceCheckpointBlobs(entityId, workspace);
            if (checkpointDeleteResult.attempted > 0) {
                logger.info(`Deleted ${checkpointDeleteResult.deleted}/${checkpointDeleteResult.attempted} workspace checkpoint blob(s) for ${entityId}`);
            }
        }

        await emitWorkspaceLifecycle(onWorkspaceLifecycle, { type: 'start', phase: 'destroy', message: 'Destroying workspace container' });
        try {
            await backend.remove(containerName, containerName);
            await emitWorkspaceLifecycle(onWorkspaceLifecycle, { type: 'finish', phase: 'destroy', success: true });
        } catch (e) {
            await emitWorkspaceLifecycle(onWorkspaceLifecycle, { type: 'finish', phase: 'destroy', success: false, error: e.message });
            throw e;
        }

        if (shouldDestroyVolume && legacyShareName) {
            await backend.destroyVolume(legacyShareName);
        }

        // Update entity workspace config
        const entityStore = getEntityStore();
        if (shouldDestroyVolume) {
            // Volume gone — clear workspace entirely so next provision starts fresh
            await entityStore.upsertEntity({
                ...entityConfig,
                workspace: null,
            });
        } else {
            const checkpoint = checkpointResult?.checkpoint || null;
            const existingCheckpointFields = getWorkspaceCheckpointMetadata(workspace);
            const checkpointEntityConfig = checkpointResult?.entityConfig || checkpoint?.entityConfig || entityConfig;
            const checkpointFields = checkpoint
                ? workspaceCheckpointFields(checkpoint)
                : (existingCheckpointFields.checkpointBlobPath ? existingCheckpointFields : null);
            const stoppedWorkspace = checkpointFields
                ? {
                    ...checkpointFields,
                    ...(checkpointEntityConfig?.workspace?.checkpointEncryptionKey
                        ? { checkpointEncryptionKey: checkpointEntityConfig.workspace.checkpointEncryptionKey }
                        : {}),
                    ...(legacyShareName ? { legacyShareName } : {}),
                }
                : {
                    // Legacy fallback for old workspace images that stored
                    // directly on Azure Files and could not produce a tarball.
                    ...(legacyShareName ? { shareName: legacyShareName } : {}),
                };

            await entityStore.upsertEntity({
                ...checkpointEntityConfig,
                workspace: stoppedWorkspace,
            });
        }

        logger.info(`Workspace destroyed for entity ${entityId}${shouldDestroyVolume ? ' (volume removed)' : ' (checkpoint preserved)'}`);
        lastActivity.delete(entityId);
        await removeWorkspaceActivityFromRedis(entityId);
        return { success: true, message: `Workspace destroyed${shouldDestroyVolume ? ' (volume removed)' : ' (volume preserved)'}` };
    } catch (e) {
        logger.error(`Failed to destroy workspace for entity ${entityId}: ${e.message}`);
        return { success: false, error: `Destroy failed: ${e.message}` };
    }
}

/**
 * Stop a workspace container without destroying it.
 * Container, volume, port bindings, and URL are all preserved for fast restart.
 *
 * @param {string} entityId - Entity UUID
 * @param {Object} entityConfig - Current entity config
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function stopWorkspace(entityId, entityConfig) {
    const workspace = entityConfig?.workspace;
    if (!workspace?.containerId) {
        return { success: false, error: 'No workspace container to stop' };
    }

    try {
        const backend = await getBackend();
        const containerName = workspace.containerId;
        await backend.stop(containerName, containerName);
    } catch (e) {
        logger.error(`Failed to stop workspace for entity ${entityId}: ${e.message}`);
        return { success: false, error: `Stop failed: ${e.message}` };
    }

    try {
        const entityStore = getEntityStore();
        await entityStore.upsertEntity({
            ...entityConfig,
            workspace: {
                ...workspace,
                status: 'stopped',
                stoppedAt: Date.now(),
            },
        });
    } catch (e) {
        logger.error(`Failed to update entity after stopping workspace: ${e.message}`);
        return { success: false, error: `Failed to update entity: ${e.message}` };
    }

    logger.info(`Workspace stopped for entity ${entityId}`);
    lastActivity.delete(entityId);
    await removeWorkspaceActivityFromRedis(entityId);
    return { success: true };
}

/**
 * Wake a stopped workspace by starting its existing container.
 * Much faster than full provisioning — no image pull, no container create.
 *
 * @param {string} entityId - Entity UUID
 * @param {Object} entityConfig - Current entity config (must have workspace.containerId)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function wakeWorkspace(entityId, entityConfig) {
    const workspace = entityConfig.workspace;
    const backend = await getBackend();
    const containerName = workspace.containerId;
    logger.info(`Waking stopped workspace for entity ${entityId}`);

    try {
        const entityStore = getEntityStore();
        await entityStore.upsertEntity({
            ...entityConfig,
            workspace: { ...workspace, status: 'starting' },
        });

        const startResult = await backend.start(workspace.containerId, containerName);
        const startedWorkspace = startResult?.url
            ? { ...workspace, url: startResult.url }
            : workspace;

        const healthOk = await waitForHealth(startedWorkspace.url, backend.wakeHealthTimeoutMs);

        if (!healthOk) {
            // Container is dead — fall back to full re-provision
            logger.warn(`Workspace for ${entityId} not healthy after wake — re-provisioning`);
            return await provisionWorkspace(entityId, entityConfig);
        }

        // Refresh from MongoDB before reconfigure/sync so wake applies the
        // latest persisted secrets even if this process has a stale cache.
        const freshEntityConfig =
            (await loadEntityConfig(entityId, { fresh: true })) || entityConfig;

        // Real stop/start restarts the workspace process, reverting the
        // in-memory secret to the bootstrap WORKSPACE_SECRET env var and
        // dropping runtime mounts. Reconfigure immediately after wake so the
        // next workspace operation does not have to discover this via 401.
        if (workspace.bootstrapSecret) {
            await reconfigureForEntity(entityId, freshEntityConfig, {
                containerName,
                shareName: workspace.shareName || null,
                legacyShareName: workspace.legacyShareName || null,
                url: startedWorkspace.url,
                bootstrapSecret: workspace.bootstrapSecret,
                containerId: workspace.containerId,
                claimedFromPool: workspace.claimedFromPool || false,
            }, backend, { destroyOnFailure: false, forceEnvRewrite: true });
        } else {
            await entityStore.upsertEntity({
                ...entityConfig,
                workspace: { ...startedWorkspace, status: 'running', stoppedAt: undefined },
            });

            // Sync entity secrets to workspace — they may have been updated
            // while the workspace was stopped. Always rewrite the file, even
            // when the user secret set is now empty, so deletions take effect.
            try {
                const systemKey = config.get('redisEncryptionKey');
                const plainSecrets = {};
                for (const [key, encVal] of Object.entries(freshEntityConfig.secrets || {})) {
                    const val = decrypt(encVal, systemKey);
                    if (val === null || val === undefined) continue;
                    plainSecrets[key] = val;
                }

                const syncResult = await syncSecretsToWorkspace(
                    entityId,
                    plainSecrets,
                );
                if (!syncResult?.success) {
                    logger.warn(
                        `Failed to sync secrets on ACI wake for ${entityId}: ${syncResult.error || 'unknown error'}`,
                    );
                }
            } catch (syncErr) {
                logger.warn(`Failed to sync secrets on ACI wake for ${entityId}: ${syncErr.message}`);
            }
        }

        logger.info(`Workspace woken for entity ${entityId}`);
        return { success: true };
    } catch (e) {
        logger.error(`Failed to wake workspace for entity ${entityId}: ${e.message}`);

        // Fall back to full re-provision
        logger.warn(`Falling back to re-provision for ${entityId}`);
        return await provisionWorkspace(entityId, entityConfig);
    }
}

/**
 * Poll a workspace's /health endpoint until it responds OK.
 */
async function waitForHealth(baseUrl, maxWaitMs) {
    const start = Date.now();
    const interval = 1000;

    while (Date.now() - start < maxWaitMs) {
        try {
            const res = await fetch(`${baseUrl}/health`, {
                signal: AbortSignal.timeout(3000),
            });
            if (res.ok) return true;
        } catch {
            // Not ready yet
        }
        await new Promise(r => setTimeout(r, interval));
    }

    return false;
}

/**
 * Write entity secrets as a .env file to the workspace container.
 * Used both at provision time and when secrets are updated via API.
 *
 * @param {string} entityId - Entity UUID
 * @param {Object} secrets - { KEY: "plaintext_value", ... }
 * @returns {Promise<Object>} { success: boolean, error?: string }
 */
export async function syncSecretsToWorkspace(entityId, secrets) {
    const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

    // Start with user secrets
    const allEnvVars = { ...(secrets || {}) };

    // Also include blob storage env vars so we don't clobber them — these are
    // written by reconfigureForEntity at provision time but would be lost if
    // we overwrote .env with only user secrets.
    try {
        const entityConfig = await loadEntityConfig(entityId);
        if (entityConfig) {
            const blobMount = await buildBlobMountPayload(entityConfig);
            if (blobMount) {
                allEnvVars.AZURE_STORAGE_ACCOUNT_NAME = blobMount.accountName;
                allEnvVars.AZURE_BLOB_SAS_TOKEN = blobMount.sasToken;
                allEnvVars.AZURE_BLOB_CONTAINER = blobMount.containerName;
            }
        }
    } catch (e) {
        logger.warn(`syncSecretsToWorkspace: failed to load blob mount info: ${e.message}`);
    }

    const envLines = Object.entries(allEnvVars)
        .filter(([k]) => SAFE_KEY.test(k))
        .map(([k, v]) => {
            const escaped = String(v).replace(/'/g, "'\\''");
            return `export ${k}='${escaped}'`;
        });
    const envContent = envLines.length > 0 ? envLines.join('\n') + '\n' : '';
    const b64 = Buffer.from(envContent).toString('base64');
    const writeResult = await workspaceRequest(entityId, '/write', {
        path: '/workspace/.env',
        content: b64,
        encoding: 'base64',
        createDirs: false,
    }, { timeoutMs: 10000 });
    if (!writeResult?.success) {
        return {
            success: false,
            error: writeResult?.error || 'Failed to write workspace secrets',
        };
    }

    // Ensure .bashrc sources .env so secrets are available in every shell
    const sourceLine = '[ -f /workspace/.env ] && . /workspace/.env';
    const bashrcResult = await workspaceRequest(entityId, '/shell', {
        command: `grep -qF '${sourceLine}' ~/.bashrc 2>/dev/null || echo '${sourceLine}' >> ~/.bashrc`,
    }, { timeoutMs: 10000 });
    if (!bashrcResult?.success) {
        return {
            success: false,
            error:
                bashrcResult?.error ||
                'Failed to register workspace secrets in shell startup',
        };
    }

    // Source it now for any currently running shells
    const sourceResult = await workspaceRequest(entityId, '/shell', {
        command: '. /workspace/.env',
    }, { timeoutMs: 10000 });
    if (!sourceResult?.success) {
        return {
            success: false,
            error:
                sourceResult?.error ||
                'Failed to source workspace secrets in the running shell',
        };
    }

    return { success: true };
}

/**
 * Stream-download a file from an entity's workspace container to a local path.
 * Uses the GET /download streaming endpoint instead of base64-in-JSON.
 *
 * @param {string} entityId - Entity UUID
 * @param {string} remotePath - Path inside the container
 * @param {string} localPath - Destination path on Cortex host
 * @returns {Promise<{success: boolean, bytesWritten?: number, error?: string}>}
 */
export async function workspaceDownloadToFile(entityId, remotePath, localPath) {
    const workspaceResult = await ensureWorkspaceReady(entityId);
    if (!workspaceResult.success) {
        return workspaceResult;
    }

    const { entityConfig } = workspaceResult;
    const { url, secret } = entityConfig.workspace;
    const endpoint = `${url}/download?path=${encodeURIComponent(remotePath)}`;
    recordWorkspaceActivity(entityId);

    const response = await fetch(endpoint, {
        headers: { 'x-workspace-secret': secret },
        signal: AbortSignal.timeout(300000), // 5-minute timeout
    });

    if (!response.ok) {
        let errMsg;
        try { errMsg = (await response.json()).error; } catch { errMsg = response.statusText; }
        return { success: false, error: errMsg || `Download failed: ${response.status}` };
    }

    const nodeStream = Readable.fromWeb(response.body);
    const ws = fs.createWriteStream(localPath);
    await pipeline(nodeStream, ws);

    const stat = fs.statSync(localPath);
    recordWorkspaceActivity(entityId);
    return { success: true, bytesWritten: stat.size };
}

/**
 * Stream-upload a local file to an entity's workspace container.
 * Uses the POST /upload streaming endpoint instead of base64-in-JSON.
 *
 * @param {string} entityId - Entity UUID
 * @param {string} localPath - Source path on Cortex host
 * @param {string} remotePath - Destination path inside the container
 * @returns {Promise<{success: boolean, bytesWritten?: number, error?: string}>}
 */
export async function workspaceUploadFile(entityId, localPath, remotePath) {
    const workspaceResult = await ensureWorkspaceReady(entityId);
    if (!workspaceResult.success) {
        return workspaceResult;
    }

    const { entityConfig } = workspaceResult;
    const { url, secret } = entityConfig.workspace;
    const endpoint = `${url}/upload?path=${encodeURIComponent(remotePath)}`;
    recordWorkspaceActivity(entityId);

    const fileStream = fs.createReadStream(localPath);
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'x-workspace-secret': secret,
            'Content-Type': 'application/octet-stream',
        },
        body: Readable.toWeb(fileStream),
        duplex: 'half',
        signal: AbortSignal.timeout(300000), // 5-minute timeout
    });

    if (!response.ok) {
        let errMsg;
        try { errMsg = (await response.json()).error; } catch { errMsg = response.statusText; }
        return { success: false, error: errMsg || `Upload failed: ${response.status}` };
    }

    const result = await response.json();
    recordWorkspaceActivity(entityId);
    return { success: true, bytesWritten: result.bytesWritten };
}

// ---------------------------------------------------------------------------
// Idle workspace reaper — runs every 5 minutes at module scope
// ---------------------------------------------------------------------------
const REAPER_INTERVAL_MS = 5 * 60 * 1000;

function activityAgeMs(now, timestamp) {
    return timestamp ? now - timestamp : null;
}

function workspaceIdleCheckpointMs(idleTimeoutMs) {
    const configured = Number(config.get('workspaceIdleCheckpointMs'));
    if (!Number.isFinite(configured) || configured <= 0) return idleTimeoutMs;
    return Math.min(configured, idleTimeoutMs);
}

function parseTimestampMs(value) {
    if (!value) return 0;
    const parsed = new Date(value).getTime();
    if (Number.isFinite(parsed)) return parsed;

    const checkpointFilenameTimestamp = String(value).match(
        /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z$/,
    );
    if (!checkpointFilenameTimestamp) return 0;

    const [, date, hour, minute, second, millis = '000'] = checkpointFilenameTimestamp;
    const normalized = `${date}T${hour}:${minute}:${second}.${millis}Z`;
    const normalizedParsed = new Date(normalized).getTime();
    return Number.isFinite(normalizedParsed) ? normalizedParsed : 0;
}

function isWorkspaceCheckpointFresh(workspace, lastActivityAt) {
    if (!workspace?.checkpointBlobPath || !lastActivityAt) return false;
    return parseTimestampMs(workspace.checkpointedAt) >= lastActivityAt;
}

function serializeWorkspaceForReaperLog(workspace) {
    if (!workspace) return null;

    return {
        containerId: workspace.containerId || null,
        shareName: workspace.shareName || null,
        legacyShareName: workspace.legacyShareName || null,
        checkpointBlobPath: workspace.checkpointBlobPath || null,
        status: workspace.status || null,
        url: workspace.url || null,
        hasSecret: Boolean(workspace.secret),
        hasBootstrapSecret: Boolean(workspace.bootstrapSecret),
        claimedFromPool: Boolean(workspace.claimedFromPool),
    };
}

function serializeJobsCheckForReaperLog(jobsCheck) {
    if (!jobsCheck) return { attempted: false };

    return {
        attempted: Boolean(jobsCheck.attempted),
        ok: jobsCheck.ok ?? null,
        hasRunningJobs: Boolean(jobsCheck.hasRunningJobs),
        reason: jobsCheck.reason || null,
        httpStatus: jobsCheck.httpStatus ?? null,
        responseType: jobsCheck.responseType || null,
        jobsContainer: jobsCheck.jobsContainer || null,
        jobCount: Array.isArray(jobsCheck.jobs) ? jobsCheck.jobs.length : null,
        runningJobCount: jobsCheck.runningJobCount ?? null,
        jobStatusCounts: jobsCheck.jobStatusCounts || null,
    };
}

function summarizeWorkspaceJobStatuses(jobs) {
    const counts = {};

    for (const job of jobs) {
        const rawStatus = typeof job?.status === 'string' ? job.status : 'missing';
        const status = ['running', 'completed', 'failed', 'stopped', 'killed', 'pending'].includes(rawStatus)
            ? rawStatus
            : 'other';
        counts[status] = (counts[status] || 0) + 1;
    }

    return counts;
}

function logWorkspaceReaperDecision(decision) {
    logger.info(`[WorkspaceReaper] ${JSON.stringify(decision)}`);
}

async function checkpointIdleWorkspaceIfNeeded(entityId, entityConfig, lastActivityAt, decisionLog) {
    const checkpointedAt = parseTimestampMs(entityConfig.workspace?.checkpointedAt);
    const checkpointFresh = isWorkspaceCheckpointFresh(entityConfig.workspace, lastActivityAt);
    decisionLog.checkpointedAt = checkpointedAt || null;
    decisionLog.checkpointFresh = checkpointFresh;
    if (checkpointFresh) {
        return { success: true, entityConfig, checkpointed: false, fresh: true };
    }

    const checkpointResult = await checkpointAndPersistWorkspace(entityId, entityConfig);
    decisionLog.checkpointResult = {
        success: Boolean(checkpointResult.success),
        skipped: Boolean(checkpointResult.skipped),
        error: checkpointResult.error || null,
        sizeMB: checkpointResult.checkpoint?.sizeMB ?? null,
    };
    if (!checkpointResult.success) {
        return {
            success: false,
            error: checkpointResult.error,
            entityConfig,
            checkpointed: false,
        };
    }
    if (checkpointResult.skipped) {
        return {
            success: true,
            entityConfig,
            checkpointed: false,
            skipped: true,
        };
    }

    return {
        success: true,
        entityConfig: checkpointResult.entityConfig || entityConfig,
        checkpointed: true,
    };
}

async function reapIdleWorkspaces() {
    const idleTimeoutMs = config.get('workspaceIdleTimeoutMs');
    if (!idleTimeoutMs) return; // disabled when set to 0

    const now = Date.now();
    const redis = await getActivityRedisClient();
    const backend = await getBackend();
    const checkpointIdleMs = backend.backendName === 'aci'
        ? workspaceIdleCheckpointMs(idleTimeoutMs)
        : idleTimeoutMs;
    const maintenanceIdleMs = Math.min(idleTimeoutMs, checkpointIdleMs);
    if (backend.backendName === 'aci') {
        const inventoryReaped = await reapAciWorkspaceInventory({ backend, redis, now, idleTimeoutMs, checkpointIdleMs });
        if (inventoryReaped) return;
    }

    const candidateEntityIds = await getWorkspaceReaperCandidates(redis, now, maintenanceIdleMs);

    for (const entityId of candidateEntityIds) {
        const localLastTs = lastActivity.get(entityId) || 0;
        const decisionLog = {
            entityId,
            now,
            idleTimeoutMs,
            checkpointIdleMs,
            localLastActivity: localLastTs || null,
            localIdleMs: activityAgeMs(now, localLastTs),
            redisConfigured: isActivityRedisConfigured(),
            lockAcquired: null,
            workspace: null,
            redisLastActivity: null,
            redisIdleMs: null,
            effectiveLastActivity: localLastTs || null,
            effectiveIdleMs: activityAgeMs(now, localLastTs),
            latestLocalActivity: null,
            latestRedisActivity: null,
            latestEffectiveActivity: null,
            latestEffectiveIdleMs: null,
            jobsCheck: { attempted: false },
            action: null,
            reason: null,
            reapMode: null,
            reapResult: null,
            checkpointedAt: null,
            checkpointFresh: null,
            checkpointResult: null,
        };

        try {
            let entityConfig = await loadEntityConfig(entityId);
            decisionLog.workspace = serializeWorkspaceForReaperLog(entityConfig?.workspace);
            if (!entityConfig?.workspace || entityConfig.workspace.status !== 'running') {
                lastActivity.delete(entityId);
                await removeWorkspaceActivityFromRedis(entityId);
                decisionLog.action = 'delete-local-activity';
                decisionLog.reason = entityConfig?.workspace
                    ? 'workspace-not-running'
                    : 'workspace-missing';
                logWorkspaceReaperDecision(decisionLog);
                continue;
            }

            const { acquired } = await acquireWorkspaceReaperLock(entityId);
            decisionLog.lockAcquired = acquired;
            if (!acquired) {
                decisionLog.action = 'skip';
                decisionLog.reason = 'reaper-lock-not-acquired';
                logWorkspaceReaperDecision(decisionLog);
                continue;
            }

            try {
                const redisActivity = await readWorkspaceActivityFromRedis(entityId, redis);
                if (!redisActivity.ok) {
                    decisionLog.action = 'skip';
                    decisionLog.reason = 'redis-activity-read-failed';
                    logWorkspaceReaperDecision(decisionLog);
                    continue;
                }
                decisionLog.redisLastActivity = redisActivity.timestamp || null;
                decisionLog.redisIdleMs = activityAgeMs(now, redisActivity.timestamp);

                const effectiveLastTs = Math.max(localLastTs, redisActivity.timestamp);
                decisionLog.effectiveLastActivity = effectiveLastTs;
                decisionLog.effectiveIdleMs = activityAgeMs(now, effectiveLastTs);
                if (now - effectiveLastTs < maintenanceIdleMs) {
                    if (effectiveLastTs !== localLastTs) {
                        lastActivity.set(entityId, effectiveLastTs);
                    }
                    decisionLog.action = 'skip';
                    decisionLog.reason = 'activity-fresh';
                    logWorkspaceReaperDecision(decisionLog);
                    continue;
                }

                const jobsCheck = await getWorkspaceBackgroundJobsStatus(entityConfig);
                decisionLog.jobsCheck = serializeJobsCheckForReaperLog(jobsCheck);
                if (jobsCheck.hasRunningJobs) {
                    logger.info(`Skipping idle stop for entity ${entityId}; workspace has running background jobs`);
                    decisionLog.action = 'skip';
                    decisionLog.reason = 'running-background-jobs';
                    logWorkspaceReaperDecision(decisionLog);
                    continue;
                }

                const latestRedisActivity = await readWorkspaceActivityFromRedis(entityId, redis);
                if (!latestRedisActivity.ok) {
                    decisionLog.action = 'skip';
                    decisionLog.reason = 'latest-redis-activity-read-failed';
                    logWorkspaceReaperDecision(decisionLog);
                    continue;
                }

                const latestLocalActivity = lastActivity.get(entityId) || 0;
                const latestActivityTs = Math.max(
                    effectiveLastTs,
                    latestRedisActivity.timestamp,
                    latestLocalActivity,
                );
                decisionLog.latestLocalActivity = latestLocalActivity || null;
                decisionLog.latestRedisActivity = latestRedisActivity.timestamp || null;
                decisionLog.latestEffectiveActivity = latestActivityTs;
                decisionLog.latestEffectiveIdleMs = activityAgeMs(now, latestActivityTs);
                if (now - latestActivityTs < maintenanceIdleMs) {
                    if (latestActivityTs !== localLastTs) {
                        lastActivity.set(entityId, latestActivityTs);
                    }
                    decisionLog.action = 'skip';
                    decisionLog.reason = 'activity-fresh-after-jobs-check';
                    logWorkspaceReaperDecision(decisionLog);
                    continue;
                }

                if (backend.backendName === 'aci' && now - latestActivityTs >= checkpointIdleMs) {
                    const checkpointResult = await checkpointIdleWorkspaceIfNeeded(
                        entityId,
                        entityConfig,
                        latestActivityTs,
                        decisionLog,
                    );
                    if (!checkpointResult.success) {
                        decisionLog.action = 'skip';
                        decisionLog.reason = 'checkpoint-failed';
                        logWorkspaceReaperDecision(decisionLog);
                        continue;
                    }
                    entityConfig = checkpointResult.entityConfig || entityConfig;

                    if (now - latestActivityTs < idleTimeoutMs) {
                        decisionLog.action = checkpointResult.checkpointed ? 'checkpoint' : 'skip';
                        decisionLog.reason = checkpointResult.checkpointed
                            ? 'idle-checkpoint'
                            : (checkpointResult.skipped ? 'checkpoint-skipped-before-reap' : 'checkpoint-fresh-before-reap');
                        logWorkspaceReaperDecision(decisionLog);
                        continue;
                    }
                }

                // ACI: checkpoint and destroy the container group so it stops
                // counting against the subscription's container-group quota.
                // The next provision restores the Blob checkpoint into a warm
                // or fresh container.
                // Docker: just stop — no quota concern, and stop preserves the
                // writable layer for a faster wake.
                const reapMode = backend.backendName === 'aci' ? 'destroy' : 'stop';
                decisionLog.reapMode = reapMode;
                const reapResult = reapMode === 'destroy'
                    ? await destroyWorkspace(entityId, entityConfig, { destroyVolume: false, lastActivityAt: latestActivityTs })
                    : await stopWorkspace(entityId, entityConfig);
                decisionLog.reapResult = {
                    success: Boolean(reapResult.success),
                    error: reapResult.error || null,
                };
                if (!reapResult.success) {
                    decisionLog.action = 'skip';
                    decisionLog.reason = `${reapMode}-failed`;
                    logWorkspaceReaperDecision(decisionLog);
                    continue;
                }

                lastActivity.delete(entityId);
                await removeWorkspaceActivityFromRedis(entityId);
                decisionLog.action = reapMode;
                decisionLog.reason = 'idle-timeout-exceeded';
                logWorkspaceReaperDecision(decisionLog);
                logger.info(`${reapMode === 'destroy' ? 'Destroyed' : 'Stopped'} idle workspace for entity ${entityId}`);
            } finally {
                await releaseWorkspaceReaperLock(entityId, redis);
            }
        } catch (e) {
            decisionLog.action = 'error';
            decisionLog.reason = e.message;
            logWorkspaceReaperDecision(decisionLog);
            logger.error(`Idle reaper error for entity ${entityId}: ${e.message}`);
        }
    }
}

function containerAgeMs(container, now) {
    const raw = container.createdAt || container.tags?.createdAt || container.startedAt;
    const createdMs = raw ? new Date(raw).getTime() : 0;
    return Number.isFinite(createdMs) && createdMs > 0 ? now - createdMs : null;
}

function isOldEnoughForContainerReap(container, now) {
    const age = containerAgeMs(container, now);
    return age !== null && age > 5 * 60 * 1000;
}

function expectedWorkspaceImageRefs() {
    const image = resolveWorkspaceImage();
    const refs = new Set([image]);
    const acrServer = config.get('azureAcrServer');
    if (acrServer && !image.includes('/')) {
        refs.add(`${acrServer}/${image}`);
    }
    return refs;
}

function isCortexOwnedWorkspaceContainer(container) {
    const tags = container.tags || {};
    if (tags.managedBy === 'cortex' && tags.workspaceContainerPrefix === workspaceContainerPrefix()) {
        return true;
    }

    const image = container.image;
    return Boolean(image && expectedWorkspaceImageRefs().has(image));
}

function entityWorkspaceContainerMatches(entityConfig, containerName) {
    return Boolean(entityConfig?.workspace?.containerId && entityConfig.workspace.containerId === containerName);
}

async function lookupWorkspaceEntityForContainer(entityStore, container) {
    const taggedEntityId = typeof container.tags?.entityId === 'string' && container.tags.entityId.trim()
        ? container.tags.entityId.trim()
        : null;

    try {
        const entityConfig = await entityStore.getEntityByWorkspaceContainerId(container.name);
        if (entityConfig) {
            return { entityConfig, entityId: entityConfig.id, lookupFailed: false, error: null };
        }
    } catch (e) {
        return {
            entityConfig: null,
            entityId: taggedEntityId,
            lookupFailed: true,
            error: e,
        };
    }

    if (!taggedEntityId) {
        return { entityConfig: null, entityId: null, lookupFailed: false, error: null };
    }

    try {
        const entityConfig = await entityStore.getEntity(taggedEntityId, {
            fresh: true,
            throwOnError: true,
        });
        if (entityConfig && !entityWorkspaceContainerMatches(entityConfig, container.name)) {
            return {
                entityConfig: null,
                entityId: entityConfig.id || taggedEntityId,
                lookupFailed: false,
                error: null,
            };
        }
        return {
            entityConfig,
            entityId: entityConfig?.id || taggedEntityId,
            lookupFailed: false,
            error: null,
        };
    } catch (e) {
        return {
            entityConfig: null,
            entityId: taggedEntityId,
            lookupFailed: true,
            error: e,
        };
    }
}

async function reapAciWorkspaceInventory({ backend, redis, now, idleTimeoutMs, checkpointIdleMs }) {
    if (typeof backend.listWorkspaceContainers !== 'function') return false;

    let containers;
    try {
        containers = await backend.listWorkspaceContainers();
    } catch (e) {
        logger.warn(`Skipping ACI workspace inventory reap; failed to list containers: ${e.message}`);
        return false;
    }

    let activePoolContainers;
    try {
        activePoolContainers = await getWarmPoolActiveContainerNames(redis);
    } catch {
        activePoolContainers = new Set();
    }

    const entityStore = getEntityStore();

    for (const container of containers) {
        const lookupResult = await lookupWorkspaceEntityForContainer(entityStore, container);
        let entityConfig = lookupResult.entityConfig;
        const entityId = lookupResult.entityId;
        const inWarmPool = activePoolContainers.has(container.name);
        const age = containerAgeMs(container, now);
        const decisionLog = {
            entityId,
            containerName: container.name,
            now,
            idleTimeoutMs,
            checkpointIdleMs,
            containerAgeMs: age,
            inWarmPool,
            ownedByCortex: isCortexOwnedWorkspaceContainer(container),
            assignedToEntity: Boolean(entityConfig),
            entityLookupFailed: lookupResult.lookupFailed,
            entityLookupError: lookupResult.error?.message || null,
            lockAcquired: null,
            workspace: serializeWorkspaceForReaperLog(entityConfig?.workspace),
            redisLastActivity: null,
            redisIdleMs: null,
            localLastActivity: entityId ? (lastActivity.get(entityId) || null) : null,
            localIdleMs: entityId ? activityAgeMs(now, lastActivity.get(entityId) || 0) : null,
            latestLocalActivity: null,
            latestRedisActivity: null,
            latestEffectiveActivity: null,
            latestEffectiveIdleMs: null,
            jobsCheck: { attempted: false },
            action: null,
            reason: null,
            reapMode: 'destroy',
            reapResult: null,
            checkpointedAt: null,
            checkpointFresh: null,
            checkpointResult: null,
        };

        if (inWarmPool && !entityConfig) {
            decisionLog.action = 'skip';
            decisionLog.reason = 'active-warm-pool';
            logWorkspaceReaperDecision(decisionLog);
            continue;
        }

        if (inWarmPool && entityConfig) {
            try {
                await removeWarmPoolEntry(container.name, redis);
                decisionLog.reason = 'stale-warm-pool-entry-removed';
            } catch (e) {
                logger.warn(`Failed to remove stale warm-pool entry for assigned container ${container.name}: ${e.message}`);
            }
        }

        if (!decisionLog.ownedByCortex) {
            decisionLog.action = 'skip';
            decisionLog.reason = 'not-cortex-owned';
            logWorkspaceReaperDecision(decisionLog);
            continue;
        }

        if (!isOldEnoughForContainerReap(container, now)) {
            decisionLog.action = 'skip';
            decisionLog.reason = 'container-too-new';
            logWorkspaceReaperDecision(decisionLog);
            continue;
        }

        if (lookupResult.lookupFailed) {
            decisionLog.action = 'skip';
            decisionLog.reason = 'entity-lookup-failed';
            logWorkspaceReaperDecision(decisionLog);
            continue;
        }

        if (!entityConfig) {
            const { acquired } = await acquireWorkspaceReaperLock(`container:${container.name}`);
            decisionLog.lockAcquired = acquired;
            if (!acquired) {
                decisionLog.action = 'skip';
                decisionLog.reason = 'reaper-lock-not-acquired';
                logWorkspaceReaperDecision(decisionLog);
                continue;
            }

            try {
                await backend.remove(container.name, container.name);
                decisionLog.action = 'destroy';
                decisionLog.reason = 'orphan-container';
                decisionLog.reapResult = { success: true, error: null };
            } catch (e) {
                decisionLog.action = 'skip';
                decisionLog.reason = 'orphan-destroy-failed';
                decisionLog.reapResult = { success: false, error: e.message };
            } finally {
                await releaseWorkspaceReaperLock(`container:${container.name}`, redis);
            }
            logWorkspaceReaperDecision(decisionLog);
            continue;
        }

        const { acquired } = await acquireWorkspaceReaperLock(entityConfig.id);
        decisionLog.lockAcquired = acquired;
        if (!acquired) {
            decisionLog.action = 'skip';
            decisionLog.reason = 'reaper-lock-not-acquired';
            logWorkspaceReaperDecision(decisionLog);
            continue;
        }

        try {
            const redisActivity = await readWorkspaceActivityFromRedis(entityConfig.id, redis);
            if (!redisActivity.ok) {
                decisionLog.action = 'skip';
                decisionLog.reason = 'redis-activity-read-failed';
                logWorkspaceReaperDecision(decisionLog);
                continue;
            }

            const localActivity = lastActivity.get(entityConfig.id) || 0;
            const effectiveActivity = Math.max(localActivity, redisActivity.timestamp);
            decisionLog.localLastActivity = localActivity || null;
            decisionLog.localIdleMs = activityAgeMs(now, localActivity);
            decisionLog.redisLastActivity = redisActivity.timestamp || null;
            decisionLog.redisIdleMs = activityAgeMs(now, redisActivity.timestamp);
            decisionLog.latestEffectiveActivity = effectiveActivity || null;
            decisionLog.latestEffectiveIdleMs = activityAgeMs(now, effectiveActivity);

            if (now - effectiveActivity < checkpointIdleMs) {
                decisionLog.action = 'skip';
                decisionLog.reason = 'activity-fresh';
                logWorkspaceReaperDecision(decisionLog);
                continue;
            }

            if (entityConfig.workspace?.status === 'running') {
                const jobsCheck = await getWorkspaceBackgroundJobsStatus(entityConfig);
                decisionLog.jobsCheck = serializeJobsCheckForReaperLog(jobsCheck);
                if (jobsCheck.hasRunningJobs) {
                    decisionLog.action = 'skip';
                    decisionLog.reason = 'running-background-jobs';
                    logWorkspaceReaperDecision(decisionLog);
                    continue;
                }
            } else {
                decisionLog.jobsCheck = {
                    attempted: false,
                    ok: true,
                    hasRunningJobs: false,
                    reason: 'workspace-not-running',
                    jobs: [],
                    runningJobCount: 0,
                };
            }

            const latestRedisActivity = await readWorkspaceActivityFromRedis(entityConfig.id, redis);
            if (!latestRedisActivity.ok) {
                decisionLog.action = 'skip';
                decisionLog.reason = 'latest-redis-activity-read-failed';
                logWorkspaceReaperDecision(decisionLog);
                continue;
            }

            const latestLocalActivity = lastActivity.get(entityConfig.id) || 0;
            const latestActivityTs = Math.max(effectiveActivity, latestLocalActivity, latestRedisActivity.timestamp);
            decisionLog.latestLocalActivity = latestLocalActivity || null;
            decisionLog.latestRedisActivity = latestRedisActivity.timestamp || null;
            decisionLog.latestEffectiveActivity = latestActivityTs || null;
            decisionLog.latestEffectiveIdleMs = activityAgeMs(now, latestActivityTs);

            if (now - latestActivityTs < checkpointIdleMs) {
                decisionLog.action = 'skip';
                decisionLog.reason = 'activity-fresh-after-jobs-check';
                logWorkspaceReaperDecision(decisionLog);
                continue;
            }

            const checkpointResult = await checkpointIdleWorkspaceIfNeeded(
                entityConfig.id,
                entityConfig,
                latestActivityTs,
                decisionLog,
            );
            if (!checkpointResult.success) {
                decisionLog.action = 'skip';
                decisionLog.reason = 'checkpoint-failed';
                logWorkspaceReaperDecision(decisionLog);
                continue;
            }
            entityConfig = checkpointResult.entityConfig || entityConfig;

            if (now - latestActivityTs < idleTimeoutMs) {
                decisionLog.action = checkpointResult.checkpointed ? 'checkpoint' : 'skip';
                decisionLog.reason = checkpointResult.checkpointed
                    ? 'idle-checkpoint'
                    : (checkpointResult.skipped ? 'checkpoint-skipped-before-reap' : 'checkpoint-fresh-before-reap');
                logWorkspaceReaperDecision(decisionLog);
                continue;
            }

            const reapResult = await destroyWorkspace(entityConfig.id, entityConfig, {
                destroyVolume: false,
                lastActivityAt: latestActivityTs,
            });
            decisionLog.reapResult = {
                success: Boolean(reapResult.success),
                error: reapResult.error || null,
            };
            decisionLog.action = reapResult.success ? 'destroy' : 'skip';
            decisionLog.reason = reapResult.success ? 'idle-timeout-exceeded' : 'destroy-failed';
            logWorkspaceReaperDecision(decisionLog);
        } finally {
            await releaseWorkspaceReaperLock(entityConfig.id, redis);
        }
    }

    return true;
}

async function getWorkspaceBackgroundJobsStatus(entityConfig) {
    const workspace = entityConfig?.workspace;
    if (!workspace?.url || !workspace?.secret) {
        return {
            attempted: false,
            ok: true,
            hasRunningJobs: false,
            reason: 'workspace-url-or-secret-missing',
            jobs: [],
            runningJobCount: 0,
        };
    }

    try {
        const {
            response,
            body: data,
            authRecovered,
        } = await fetchWorkspaceJsonWithAuthRecovery(entityConfig?.id, entityConfig, '/shell/jobs', {
            timeoutMs: 10_000,
        });

        if (!response.ok) {
            logger.warn(`Workspace background-job check failed: HTTP ${response.status}`);
            return {
                attempted: true,
                ok: false,
                hasRunningJobs: true,
                reason: 'http-error',
                httpStatus: response.status,
                authRecovered,
                jobs: null,
                runningJobCount: null,
            };
        }

        const responseType = Array.isArray(data) ? 'array' : typeof data;
        const jobsContainer = Array.isArray(data)
            ? 'response-array'
            : (Array.isArray(data?.jobs) ? 'jobs-property' : null);
        const jobs = Array.isArray(data)
            ? data
            : (Array.isArray(data?.jobs) ? data.jobs : null);
        if (!jobs) {
            logger.warn('Workspace background-job check failed: malformed jobs response');
            return {
                attempted: true,
                ok: false,
                hasRunningJobs: true,
                reason: 'malformed-response',
                httpStatus: response.status,
                authRecovered,
                responseType,
                jobsContainer,
                jobs: null,
                runningJobCount: null,
                jobStatusCounts: null,
            };
        }

        const runningJobs = jobs.filter(job => job?.status === 'running');
        const jobStatusCounts = summarizeWorkspaceJobStatuses(jobs);
        if (runningJobs.length > 0) {
            logger.info(`Workspace background-job check found ${runningJobs.length} running job(s)`);
        }
        return {
            attempted: true,
            ok: true,
            hasRunningJobs: runningJobs.length > 0,
            reason: runningJobs.length > 0 ? 'running-jobs-found' : 'no-running-jobs',
            httpStatus: response.status,
            authRecovered,
            responseType,
            jobsContainer,
            jobs,
            runningJobCount: runningJobs.length,
            jobStatusCounts,
        };
    } catch (e) {
        logger.warn(`Workspace background-job check failed: ${e.message}`);
        return {
            attempted: true,
            ok: false,
            hasRunningJobs: true,
            reason: 'request-failed',
            error: e.message,
            jobs: null,
            runningJobCount: null,
        };
    }
}

async function hasRunningBackgroundJobs(entityConfig) {
    const jobsCheck = await getWorkspaceBackgroundJobsStatus(entityConfig);
    return jobsCheck.hasRunningJobs;
}

// Combined interval: reap idle workspaces. Activity is written through to Redis
// on each successful workspace request, so the reaper does not persist activity
// into the entity document.
const _reaperTimer = setInterval(async () => {
    try {
        await reapIdleWorkspaces();
    } catch (e) {
        logger.error(`Workspace reaper tick failed: ${e.message}`);
    }
}, REAPER_INTERVAL_MS);

// Allow the process to exit cleanly without waiting for the reaper timer
if (_reaperTimer.unref) _reaperTimer.unref();

// ---------------------------------------------------------------------------
// Warm pool initialization — delayed to avoid blocking startup
// ---------------------------------------------------------------------------
setTimeout(() => {
    initWarmPool().catch(e => logger.error(`Warm pool initialization failed: ${e.message}`));
}, 5000);

function setActivityRedisClientForTest(client) {
    _activityRedisClientOverride = client;
    _activityRedisClient = null;
}

function setWorkspaceCheckpointUploadForTest(fn) {
    _workspaceCheckpointUploadOverride = fn;
}

function setWorkspaceCheckpointContainerClientForTest(client) {
    _workspaceCheckpointContainerClientOverride = client;
}

function setWorkspaceLegacyShareUploadForTest(fn) {
    _workspaceLegacyShareUploadOverride = fn;
}

function resetActivityStateForTest() {
    lastActivity.clear();
    _activityRedisClientOverride = undefined;
    _activityRedisClient = null;
    _activityRedisClientConnectPromise = null;
    _workspaceCheckpointUploadOverride = undefined;
    _workspaceCheckpointContainerClientOverride = undefined;
    _workspaceLegacyShareUploadOverride = undefined;
}

// Test-only: delete the Redis activity key for an entity so the reaper sees it
// as stale. Without this, integration tests can't force a reap because their
// own provisioning writes fresh activity.
async function clearRedisActivityForTest(entityId) {
    const redis = await getActivityRedisClient();
    if (!redis) return false;
    try {
        await redis.del(workspaceActivityKey(entityId));
        await redis.zrem(workspaceActivityIndexKey(), entityId);
        return true;
    } catch {
        return false;
    }
}

// Test-only exports for targeted unit coverage of recovery/provision paths.
export const __testables = {
    checkpointWorkspace,
    checkpointLegacyShareAfterProvision,
    createGenericContainer,
    getWorkspaceBackgroundJobsStatus,
    getWorkspaceCheckpointStorageConfig,
    getOrCreateWorkspaceCheckpointEncryptionKey,
    hasRunningBackgroundJobs,
    isEncryptedStreamingCheckpointWorkspace,
    reapIdleWorkspaces,
    recordWorkspaceActivity,
    removeWorkspaceActivityFromRedis,
    reconfigureForEntity,
    restoreLegacyShareArchiveToContainer,
    restoreWorkspaceCheckpointToContainer,
    uploadWorkspaceCheckpoint,
    setActivityRedisClientForTest,
    setWorkspaceCheckpointContainerClientForTest,
    setWorkspaceCheckpointUploadForTest,
    setWorkspaceLegacyShareUploadForTest,
    setupWorkspaceContainerForEntity,
    resetActivityStateForTest,
    clearRedisActivityForTest,
    validateWorkspaceCheckpointMetadata,
    buildWorkspaceCheckpointRestoreEncryption,
    checkpointEncryptionFromMetadata,
    checkpointEncryptionMetadata,
    workspaceCheckpointBlobMetadata,
    workspaceCheckpointBlobPath,
    workspaceCheckpointBlobPathCandidates,
    workspaceCheckpointEncryptionKeyId,
    workspaceCheckpointIdentityHash,
    lastActivity,
};
