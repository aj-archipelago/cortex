// warmPool.js
// Pre-provisions ACI containers so the first workspace request is instant (~1-2s
// reconfigure call instead of 90-120s cold provision). ACI-only.
//
// Security model: "born clean, die on release"
// - Pool containers start fresh — no entity data, no secrets, just a bootstrap secret
// - When claimed: /reconfigure rotates the secret, injects env vars, mounts blob storage
// - When entity is done: container is destroyed (never recycled entity-to-entity)
//
// Pool state is backed by Redis so it survives restarts and is shared across hosts.

import crypto from 'node:crypto';
import os from 'node:os';
import logger from '../../../../../lib/logger.js';
import { config } from '../../../../../config.js';
import { parseMemoryToMB, resolveWorkspaceImage } from './workspace_client.js';

const REPLENISH_INTERVAL_MS = 60_000;
const REPLENISH_LOCK_TTL_MS = 6 * 60 * 1000;  // must exceed STUCK_PROVISION_TIMEOUT_MS
const STUCK_PROVISION_TIMEOUT_MS = 5 * 60 * 1000;
const CLAIMED_CONTAINER_TIMEOUT_MS = 30 * 60 * 1000;

let _replenishTimer = null;
let _hostId = null;

// Redis key helpers
function keyPrefix() {
    return `${config.get('cortexId')}-warmpool`;
}
function containersKey() { return `${keyPrefix()}:containers`; }
function readyKey() { return `${keyPrefix()}:ready`; }
function replenishLockKey() { return `${keyPrefix()}:replenish-lock`; }
function workspaceContainerPrefix() { return config.get('workspaceContainerPrefix') || 'workspace-local'; }

function isPoolEntryActive(entry) {
    return entry?.status === 'READY' || entry?.status === 'PROVISIONING';
}

function isStuckProvisioning(entry, now = Date.now()) {
    if (entry?.status !== 'PROVISIONING') return false;
    const createdAt = new Date(entry.createdAt).getTime();
    return Number.isFinite(createdAt) && now - createdAt > STUCK_PROVISION_TIMEOUT_MS;
}

function isFreshClaimed(entry, now = Date.now()) {
    if (entry?.status !== 'CLAIMED') return false;
    const claimedAt = new Date(entry.claimedAt).getTime();
    return Number.isFinite(claimedAt) && now - claimedAt <= CLAIMED_CONTAINER_TIMEOUT_MS;
}

function isPoolEntryProtected(entry) {
    return isPoolEntryActive(entry) || isFreshClaimed(entry);
}

// ---------------------------------------------------------------------------
// Lazy singleton Redis client (follows pattern from lib/fileUtils.js)
// ---------------------------------------------------------------------------
let _redisClient = null;

async function getRedisClient() {
    if (_redisClient) return _redisClient;

    try {
        const connectionString = config.get('storageConnectionString');
        if (!connectionString) return null;

        const Redis = (await import('ioredis')).default;
        _redisClient = new Redis(connectionString, {
            maxRetriesPerRequest: null,
            enableReadyCheck: true,
            lazyConnect: false,
            connectTimeout: 10000,
        });

        _redisClient.on('error', (error) => {
            logger.error(`[WarmPool] Redis client error: ${error.message}`);
        });

        return _redisClient;
    } catch (e) {
        logger.error(`[WarmPool] Failed to create Redis client: ${e.message}`);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize the warm pool. Called once at startup.
 * Discovers existing pool containers from Redis, then kicks off replenishment.
 */
export async function initWarmPool() {
    const poolSize = config.get('warmPoolSize');

    if (!poolSize || poolSize <= 0) {
        logger.info('[WarmPool] Disabled (WARM_POOL_SIZE=0 or unset)');
        return;
    }

    if (config.get('workspaceBackend') !== 'aci') {
        logger.info('[WarmPool] Disabled (only supported on ACI backend)');
        return;
    }

    if (!config.get('warmPoolEnabled')) {
        logger.info('[WarmPool] Disabled (WARM_POOL_ENABLED=false or unset)');
        return;
    }

    const redis = await getRedisClient();
    if (!redis) {
        logger.warn('[WarmPool] Disabled — Redis not available');
        return;
    }

    _hostId = `${config.get('cortexId')}-${os.hostname()}-${process.pid}`;
    logger.info(`[WarmPool] Initializing with target size ${poolSize}, hostId=${_hostId}`);

    // Discover existing containers from Redis and health-check them
    await discoverExistingContainers(redis).catch(e =>
        logger.error(`[WarmPool] Discovery failed: ${e.message}`)
    );

    // Initial replenishment (background — don't block startup)
    replenish(redis).catch(e => logger.error(`[WarmPool] Initial replenish failed: ${e.message}`));

    // Periodic replenishment
    _replenishTimer = setInterval(() => {
        replenish(redis).catch(e => logger.error(`[WarmPool] Periodic replenish failed: ${e.message}`));
    }, REPLENISH_INTERVAL_MS);

    if (_replenishTimer.unref) _replenishTimer.unref();
}

/**
 * Claim a READY container from the pool.
 * Uses atomic SPOP on the Redis ready set.
 * Returns container info and removes it from the registry.
 * Triggers background replenishment.
 *
 * @returns {Promise<{ success: boolean, containerName?: string, url?: string, bootstrapSecret?: string, containerId?: string }>}
 */
export async function claimContainer(entityId, redisClient = null) {
    const redis = redisClient || await getRedisClient();
    if (!redis) return { success: false };

    try {
        let containerName = null;
        let entry = null;

        while (true) {
            // Atomic pop of one random member from the ready set
            containerName = await redis.spop(readyKey());
            if (!containerName) return { success: false };

            // Get container details from the registry hash
            const raw = await redis.hget(containersKey(), containerName);
            if (!raw) {
                // Race condition — another host already cleaned it up
                continue;
            }

            entry = JSON.parse(raw);
            const validation = await validatePoolContainerInAci(containerName, entry);
            if (validation.valid !== false) break;

            await redis.hdel(containersKey(), containerName);
            logger.warn(`[WarmPool] Removed stale READY entry ${containerName}; ${validation.reason}`);
            if (validation.removeContainer) {
                const { default: ACIBackend } = await import('./backends/ACIBackend.js');
                const backend = new ACIBackend();
                backend.remove(entry.containerId || containerName, containerName).catch(() => {});
            }
        }

        entry.status = 'CLAIMED';
        entry.claimedAt = new Date().toISOString();
        entry.claimedByEntityId = entityId || null;
        await redis.hset(containersKey(), containerName, JSON.stringify(entry));
        await redis.srem(readyKey(), containerName);

        logger.info(`[WarmPool] Claimed container ${containerName}`);

        // Tag the Azure resource with the claiming entityId so the orphan
        // reconciler can distinguish claimed pool containers from true orphans
        // without a cross-database Mongo lookup. Best-effort — never fail the
        // claim because tagging fell over.
        if (entityId) {
            try {
                const { default: ACIBackend } = await import('./backends/ACIBackend.js');
                const backend = new ACIBackend();
                await backend.setEntityTag(containerName, entityId);
            } catch (e) {
                logger.warn(`[WarmPool] Failed to tag ${containerName} with entityId=${entityId}: ${e.message}`);
            }
        }

        // Trigger background replenishment
        replenish(redis).catch(e => logger.error(`[WarmPool] Post-claim replenish failed: ${e.message}`));

        return {
            success: true,
            containerName,
            url: entry.url,
            bootstrapSecret: entry.bootstrapSecret,
            containerId: entry.containerId,
            imageVersion: entry.imageVersion || null,
        };
    } catch (e) {
        logger.error(`[WarmPool] Claim failed: ${e.message}`);
        return { success: false };
    }
}

/**
 * Get pool status for monitoring.
 */
export async function getPoolStatus() {
    const redis = await getRedisClient();
    if (!redis) {
        return { ready: 0, provisioning: 0, total: 0, targetSize: config.get('warmPoolSize'), entries: [] };
    }

    try {
        const all = await redis.hgetall(containersKey());
        const entries = [];
        let ready = 0;
        let provisioning = 0;

        for (const [name, raw] of Object.entries(all)) {
            const entry = JSON.parse(raw);
            if (entry.status === 'READY') ready++;
            if (entry.status === 'PROVISIONING') provisioning++;
            entries.push({ name, status: entry.status, createdAt: entry.createdAt });
        }

        return { ready, provisioning, total: entries.length, targetSize: config.get('warmPoolSize'), entries };
    } catch (e) {
        logger.error(`[WarmPool] Failed to get pool status: ${e.message}`);
        return { ready: 0, provisioning: 0, total: 0, targetSize: config.get('warmPoolSize'), entries: [] };
    }
}

export async function getWarmPoolActiveContainerNames(redisClient = null) {
    const redis = redisClient || await getRedisClient();
    if (!redis) return new Set();

    try {
        const all = await redis.hgetall(containersKey());
        const active = new Set();
        for (const [name, raw] of Object.entries(all)) {
            const entry = JSON.parse(raw);
            if (isPoolEntryProtected(entry)) {
                active.add(name);
            }
        }
        return active;
    } catch (e) {
        logger.warn(`[WarmPool] Failed to read active pool containers: ${e.message}`);
        return new Set();
    }
}

export async function releaseClaimedContainer(containerName, redisClient = null) {
    if (!containerName) return;
    const redis = redisClient || await getRedisClient();
    if (!redis) return;

    try {
        const raw = await redis.hget(containersKey(), containerName);
        if (!raw) return;

        const entry = JSON.parse(raw);
        if (entry.status !== 'CLAIMED') return;

        await redis.hdel(containersKey(), containerName);
        await redis.srem(readyKey(), containerName);
    } catch (e) {
        logger.warn(`[WarmPool] Failed to release claimed container ${containerName}: ${e.message}`);
    }
}

export async function removeWarmPoolEntry(containerName, redisClient = null) {
    if (!containerName) return;
    const redis = redisClient || await getRedisClient();
    if (!redis) return;

    await redis.hdel(containersKey(), containerName);
    await redis.srem(readyKey(), containerName);
}

/**
 * Graceful shutdown: do NOT destroy pool containers.
 * They persist in Redis for other hosts / next restart to discover.
 * Only clear the replenish timer.
 */
export async function drainPool() {
    if (_replenishTimer) {
        clearInterval(_replenishTimer);
        _replenishTimer = null;
    }

    logger.info('[WarmPool] Shutdown — pool containers preserved in Redis for next startup');
}

// ---------------------------------------------------------------------------
// Startup Discovery
// ---------------------------------------------------------------------------

/**
 * Discover existing pool containers from Redis on startup.
 * Health-check READY entries, clean up stale/failed ones.
 */
async function discoverExistingContainers(redis) {
    const all = await redis.hgetall(containersKey());
    const containerNames = Object.keys(all);

    if (containerNames.length === 0) {
        logger.info('[WarmPool] No existing pool containers in Redis');
        return;
    }

    logger.info(`[WarmPool] Discovered ${containerNames.length} pool container(s) in Redis`);

    const { default: ACIBackend } = await import('./backends/ACIBackend.js');
    const backend = new ACIBackend();
    const inventory = await getPoolContainerInventory(backend);

    for (const [containerName, raw] of Object.entries(all)) {
        const entry = JSON.parse(raw);

        if (entry.status === 'READY') {
            const inventoryResult = validatePoolContainerInventoryEntry(containerName, inventory, entry);
            if (inventoryResult.valid === false) {
                const removed = await redis.hdel(containersKey(), containerName);
                await redis.srem(readyKey(), containerName);
                logger.warn(`[WarmPool] Removed stale ${entry.status} entry ${containerName}; ${inventoryResult.reason}`);
                if (removed && inventoryResult.removeContainer) {
                    backend.remove(entry.containerId || containerName, containerName).catch(() => {});
                }
                continue;
            }
        }

        if (entry.status === 'FAILED') {
            // Clean up failed entries
            await redis.hdel(containersKey(), containerName);
            await redis.srem(readyKey(), containerName);
            logger.info(`[WarmPool] Removed FAILED entry ${containerName}`);
            continue;
        }

        if (entry.status === 'PROVISIONING') {
            const age = Date.now() - new Date(entry.createdAt).getTime();
            if (age > STUCK_PROVISION_TIMEOUT_MS) {
                // Stuck provisioning — clean up
                logger.warn(`[WarmPool] Removing stuck PROVISIONING container ${containerName} (age=${Math.round(age / 1000)}s)`);
                const removed = await redis.hdel(containersKey(), containerName);
                await redis.srem(readyKey(), containerName);
                // Only destroy if we actually owned the removal (hdel returned 1).
                // If 0, claim() already took it — don't destroy a claimed container's share.
                if (removed) {
                    backend.remove(entry.containerId || containerName, containerName).catch(() => {});
                }
                continue;
            }
            // Still provisioning and not stuck — leave it
            continue;
        }

        if (entry.status === 'READY') {
            // Health-check the container
            const healthy = await checkHealth(entry.url);
            if (healthy) {
                // Ensure it's in the ready set
                await redis.sadd(readyKey(), containerName);
                logger.info(`[WarmPool] Existing container ${containerName} is healthy`);
            } else {
                // Dead — remove from Redis and destroy
                logger.warn(`[WarmPool] Container ${containerName} failed health check — removing`);
                const removed = await redis.hdel(containersKey(), containerName);
                await redis.srem(readyKey(), containerName);
                if (removed) {
                    backend.remove(entry.containerId || containerName, containerName).catch(() => {});
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Replenishment with distributed lock
// ---------------------------------------------------------------------------

/**
 * Replenish the pool to the target size.
 * Uses a Redis lock to ensure only one host replenishes at a time.
 */
async function replenish(redis) {
    const targetSize = config.get('warmPoolSize');
    if (!targetSize || targetSize <= 0) return;

    // Count active entries (READY + PROVISIONING)
    const all = await redis.hgetall(containersKey());
    let active = 0;
    let hasStuckProvisioning = false;
    for (const raw of Object.values(all)) {
        const entry = JSON.parse(raw);
        if (isPoolEntryActive(entry)) active++;
        if (isStuckProvisioning(entry)) hasStuckProvisioning = true;
    }

    const deficit = targetSize - active;
    if (deficit <= 0 && !hasStuckProvisioning) return;

    // Acquire distributed lock
    const lockAcquired = await redis.set(
        replenishLockKey(),
        _hostId,
        'NX',
        'PX',
        REPLENISH_LOCK_TTL_MS,
    );

    if (!lockAcquired) {
        logger.debug('[WarmPool] Another host is replenishing — skipping');
        return;
    }

    try {
        await pruneStalePoolEntries(redis);

        // Double-check after acquiring lock
        const allAfterLock = await redis.hgetall(containersKey());
        let activeAfterLock = 0;
        for (const raw of Object.values(allAfterLock)) {
            const entry = JSON.parse(raw);
            if (isPoolEntryActive(entry)) activeAfterLock++;
        }

        const confirmedDeficit = targetSize - activeAfterLock;
        if (confirmedDeficit <= 0) return;

        // Clean up any FAILED entries
        for (const [name, raw] of Object.entries(allAfterLock)) {
            const entry = JSON.parse(raw);
            if (entry.status === 'FAILED') {
                await redis.hdel(containersKey(), name);
                await redis.srem(readyKey(), name);
            }
        }

        logger.info(`[WarmPool] Replenishing ${confirmedDeficit} container(s) (active=${activeAfterLock}, target=${targetSize})`);

        const provisions = [];
        for (let i = 0; i < confirmedDeficit; i++) {
            provisions.push(provisionPoolContainer(redis));
        }

        await Promise.allSettled(provisions);
    } finally {
        // Release lock only if we still own it
        try {
            const currentOwner = await redis.get(replenishLockKey());
            if (currentOwner === _hostId) {
                await redis.del(replenishLockKey());
            }
        } catch {
            // Best-effort lock release
        }
    }
}

async function getPoolContainerInventory(backend = null) {
    try {
        let resolvedBackend = backend;
        if (!resolvedBackend) {
            const { default: ACIBackend } = await import('./backends/ACIBackend.js');
            resolvedBackend = new ACIBackend();
        }
        if (typeof resolvedBackend.listWorkspaceContainers !== 'function') {
            return { available: false, containersByName: new Map(), error: 'ACI inventory unavailable' };
        }

        const containers = await resolvedBackend.listWorkspaceContainers();
        return {
            available: true,
            containersByName: new Map(containers
                .filter(container => container.name)
                .map(container => [container.name, container])),
            error: null,
        };
    } catch (e) {
        logger.warn(`[WarmPool] Skipping ACI pool inventory validation: ${e.message}`);
        return { available: false, containersByName: new Map(), error: e.message };
    }
}

function validatePoolContainerInventoryEntry(containerName, inventory, entry = null) {
    if (!inventory.available) return { valid: null, reason: inventory.error || 'ACI inventory unavailable' };
    const container = inventory.containersByName.get(containerName);
    if (!container) {
        return { valid: false, reason: 'not present in ACI inventory for current workspace prefix' };
    }
    if (container.tags?.workspaceRole !== 'pool') {
        return { valid: false, reason: `ACI inventory role is ${container.tags?.workspaceRole || 'unset'}, not pool` };
    }
    const expectedVersion = config.get('workspaceImageVersion');
    const actualVersion = container.tags?.imageVersion || entry?.imageVersion || null;
    if (expectedVersion && actualVersion && actualVersion !== expectedVersion) {
        return {
            valid: false,
            reason: `stale image (${actualVersion} vs ${expectedVersion})`,
            removeContainer: true,
        };
    }
    return { valid: true, reason: null };
}

async function validatePoolContainerInAci(containerName, entry = null) {
    const inventory = await getPoolContainerInventory();
    return validatePoolContainerInventoryEntry(containerName, inventory, entry);
}

async function pruneStalePoolEntries(redis) {
    const all = await redis.hgetall(containersKey());
    if (Object.keys(all).length === 0) return 0;

    const inventory = await getPoolContainerInventory();
    let pruned = 0;
    for (const [containerName, raw] of Object.entries(all)) {
        const entry = JSON.parse(raw);

        if (isStuckProvisioning(entry)) {
            logger.warn(`[WarmPool] Removing stuck PROVISIONING container ${containerName} (age=${Math.round((Date.now() - new Date(entry.createdAt).getTime()) / 1000)}s)`);
            const removed = await redis.hdel(containersKey(), containerName);
            await redis.srem(readyKey(), containerName);
            if (removed) {
                pruned += 1;
                const { default: ACIBackend } = await import('./backends/ACIBackend.js');
                const backend = new ACIBackend();
                backend.remove(entry.containerId || containerName, containerName).catch(() => {});
            }
            continue;
        }

        if (entry.status === 'CLAIMED' && !isFreshClaimed(entry)) {
            logger.warn(`[WarmPool] Removing stale CLAIMED container ${containerName} (age=${Math.round((Date.now() - new Date(entry.claimedAt).getTime()) / 1000)}s)`);
            await redis.hdel(containersKey(), containerName);
            await redis.srem(readyKey(), containerName);
            pruned += 1;
            continue;
        }

        if (entry.status !== 'READY') continue;
        if (!inventory.available) continue;

        const result = validatePoolContainerInventoryEntry(containerName, inventory, entry);
        if (result.valid !== false) continue;

        await redis.hdel(containersKey(), containerName);
        await redis.srem(readyKey(), containerName);
        pruned += 1;
        logger.warn(`[WarmPool] Removed stale ${entry.status} entry ${containerName}; ${result.reason}`);
    }
    return pruned;
}

// ---------------------------------------------------------------------------
// Pool container provisioning
// ---------------------------------------------------------------------------

/**
 * Provision a single pool container.
 * Container naming: {WORKSPACE_CONTAINER_PREFIX}-pool-{12-char-uuid}
 */
async function provisionPoolContainer(redis) {
    const bootstrapSecret = crypto.randomBytes(32).toString('hex');
    const shortId = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const containerName = `${workspaceContainerPrefix()}-pool-${shortId}`;

    const entry = {
        url: null,
        bootstrapSecret,
        status: 'PROVISIONING',
        containerId: null,
        createdAt: new Date().toISOString(),
        hostId: _hostId,
        imageVersion: config.get('workspaceImageVersion') || null,
    };

    // Register in Redis as PROVISIONING
    await redis.hset(containersKey(), containerName, JSON.stringify(entry));

    try {
        const { default: ACIBackend } = await import('./backends/ACIBackend.js');
        const backend = new ACIBackend();

        const image = resolveWorkspaceImage();
        const cpus = parseFloat(config.get('workspaceCpus'));
        const memory = config.get('workspaceMemory');
        const memoryMB = parseMemoryToMB(memory);

        const env = [
            `WORKSPACE_SECRET=${bootstrapSecret}`,
            `PORT=3100`,
        ];

        logger.info(`[WarmPool] Provisioning pool container ${containerName}`);

        const { containerId, url } = await backend.createAndStart({
            containerName,
            image,
            env,
            cpus,
            memoryMB,
            diskSize: config.get('workspaceDiskSize'),
            tags: {
                workspaceRole: 'pool',
                createdAt: entry.createdAt,
            },
        });

        // Wait for health
        const healthOk = await waitForHealth(url, backend.healthTimeoutMs);

        if (!healthOk) {
            throw new Error('Pool container failed to become healthy');
        }

        // Update entry to READY in Redis
        entry.url = url;
        entry.containerId = containerId;
        entry.status = 'READY';
        await redis.hset(containersKey(), containerName, JSON.stringify(entry));
        await redis.sadd(readyKey(), containerName);

        logger.info(`[WarmPool] Pool container ${containerName} ready at ${url}`);
    } catch (e) {
        logger.error(`[WarmPool] Failed to provision pool container ${containerName}: ${e.message}`);

        // Mark as FAILED in Redis
        entry.status = 'FAILED';
        await redis.hset(containersKey(), containerName, JSON.stringify(entry));
        await redis.srem(readyKey(), containerName);

        // Best-effort cleanup of the failed pool container.
        try {
            const { default: ACIBackend } = await import('./backends/ACIBackend.js');
            const backend = new ACIBackend();
            await backend.remove(containerName, containerName);
        } catch {
            // Ignore cleanup errors
        }
    }
}

// Test-only exports for targeted unit coverage of provisioning semantics.
export const __testables = {
    getWarmPoolActiveContainerNames,
    pruneStalePoolEntries,
    provisionPoolContainer,
    releaseClaimedContainer,
    replenish,
    validatePoolContainerInventoryEntry,
};

// ---------------------------------------------------------------------------
// Health checking
// ---------------------------------------------------------------------------

/**
 * Quick health check — single attempt with short timeout.
 * Used by discovery to validate existing containers.
 */
async function checkHealth(baseUrl) {
    try {
        const res = await fetch(`${baseUrl}/health`, {
            signal: AbortSignal.timeout(5000),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Poll a container's /health endpoint until it responds OK.
 * Used during provisioning where we need to wait for startup.
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
