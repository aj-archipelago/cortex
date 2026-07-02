import test from 'ava';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import logger from '../../../lib/logger.js';
import { config } from '../../../config.js';
import { getEntityStore } from '../../../lib/MongoEntityStore.js';

let warmPoolModule;
let workspaceClientModule;
let ACIBackend;

test.before(async () => {
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = () => ({ unref() {} });

    try {
        warmPoolModule = await import('../../../pathways/system/entity/tools/shared/warmPool.js');
        workspaceClientModule = await import('../../../pathways/system/entity/tools/shared/workspace_client.js');
        ({ default: ACIBackend } = await import('../../../pathways/system/entity/tools/shared/backends/ACIBackend.js'));
    } finally {
        global.setTimeout = originalSetTimeout;
    }
});

test('workspaceRequest rejects blank entity ids before provisioning', async (t) => {
    const loggerStub = stubLogger();
    t.teardown(() => loggerStub.restore());

    const result = await workspaceClientModule.workspaceRequest('', '/health');

    t.false(result.success);
    t.is(result.error, 'Workspace entityId is required');
    t.true(loggerStub.calls.some(call => call.message === 'Workspace request skipped: missing entityId'));
});

test('workspace checkpoints prefer workspace Azure Files storage account', (t) => {
    const restoreConfig = stubConfig({
        azureStorageAccountName: 'general-blob-account',
        azureStorageAccountKey: 'general-key',
        workspaceAzureFilesStorageAccountName: 'workspace-files-account',
        workspaceAzureFilesStorageAccountKey: 'workspace-key',
        azureBlobContainerName: 'checkpoint-container',
    });

    try {
        t.deepEqual(workspaceClientModule.__testables.getWorkspaceCheckpointStorageConfig(), {
            accountName: 'workspace-files-account',
            accountKey: 'workspace-key',
            containerName: 'checkpoint-container',
        });
    } finally {
        restoreConfig();
    }
});

test('workspace checkpoint blob paths are collision-resistant for sanitized entity ids', (t) => {
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
    });

    try {
        const underscorePath = workspaceClientModule.__testables.workspaceCheckpointBlobPath('entity_abc');
        const hyphenPath = workspaceClientModule.__testables.workspaceCheckpointBlobPath('entity-abc');
        const candidates = workspaceClientModule.__testables.workspaceCheckpointBlobPathCandidates('entity_abc');

        t.not(underscorePath, hyphenPath);
        t.true(underscorePath.includes(workspaceClientModule.__testables.workspaceCheckpointIdentityHash('entity_abc')));
        t.true(hyphenPath.includes(workspaceClientModule.__testables.workspaceCheckpointIdentityHash('entity-abc')));
        t.deepEqual(candidates, [
            underscorePath,
            'workspace-checkpoints/test-cortex/entity-abc/workspace.tar.gz',
        ]);
    } finally {
        restoreConfig();
    }
});

test('workspace checkpoint metadata validates exact entity identity', (t) => {
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
    });

    try {
        const metadata = workspaceClientModule.__testables.workspaceCheckpointBlobMetadata('entity_abc');

        t.true(workspaceClientModule.__testables.validateWorkspaceCheckpointMetadata(metadata, 'entity_abc'));
        t.throws(
            () => workspaceClientModule.__testables.validateWorkspaceCheckpointMetadata(metadata, 'entity-abc'),
            { message: 'Workspace checkpoint entity metadata does not match requested entity' },
        );
        t.throws(
            () => workspaceClientModule.__testables.validateWorkspaceCheckpointMetadata({}, 'entity_abc'),
            { message: 'Workspace checkpoint is missing entity identity metadata' },
        );
    } finally {
        restoreConfig();
    }
});

test.serial('workspace checkpoint encryption key is stored encrypted and used for restore material', async (t) => {
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        redisEncryptionKey: 'a'.repeat(64),
    });
    const store = stubMutableEntityStore({
        id: 'entity-encrypted-checkpoint',
        workspace: {
            status: 'running',
        },
    });

    try {
        const result = await workspaceClientModule.__testables.getOrCreateWorkspaceCheckpointEncryptionKey(
            'entity-encrypted-checkpoint',
            store.getEntity(),
        );

        t.is(result.algorithm, 'aes-256-gcm');
        t.is(Buffer.from(result.keyBase64, 'base64').length, 32);
        t.truthy(result.keyId);
        t.not(store.getEntity().workspace.checkpointEncryptionKey.encryptedKey, result.keyBase64);
        t.is(store.getEntity().workspace.checkpointEncryptionKey.keyId, result.keyId);

        const restoreMaterial = workspaceClientModule.__testables.buildWorkspaceCheckpointRestoreEncryption({
            ...store.getEntity(),
            workspace: {
                ...store.getEntity().workspace,
                checkpointEncryption: {
                    algorithm: 'aes-256-gcm',
                    keyId: result.keyId,
                    ivBase64: Buffer.alloc(12, 1).toString('base64'),
                    tagBase64: Buffer.alloc(16, 2).toString('base64'),
                    compression: 'zstd',
                },
            },
        });

        t.is(restoreMaterial.keyBase64, result.keyBase64);
        t.is(restoreMaterial.keyId, result.keyId);
        t.is(restoreMaterial.ivBase64, Buffer.alloc(12, 1).toString('base64'));
        t.is(restoreMaterial.tagBase64, Buffer.alloc(16, 2).toString('base64'));
        t.is(restoreMaterial.compression, 'zstd');
    } finally {
        store.restore();
        restoreConfig();
    }
});

test.serial('workspace checkpoint encryption key creation reuses a freshly stored key', async (t) => {
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        redisEncryptionKey: 'b'.repeat(64),
    });
    const store = stubMutableEntityStore({
        id: 'entity-encrypted-checkpoint-race',
        workspace: {
            status: 'running',
        },
    });

    try {
        const existing = await workspaceClientModule.__testables.getOrCreateWorkspaceCheckpointEncryptionKey(
            'entity-encrypted-checkpoint-race',
            store.getEntity(),
        );
        const freshEntity = store.getEntity();

        const result = await workspaceClientModule.__testables.getOrCreateWorkspaceCheckpointEncryptionKey(
            'entity-encrypted-checkpoint-race',
            {
                id: 'entity-encrypted-checkpoint-race',
                workspace: {
                    status: 'running',
                },
            },
        );

        t.is(result.keyId, existing.keyId);
        t.is(result.keyBase64, existing.keyBase64);
        t.is(store.getEntity(), freshEntity);
    } finally {
        store.restore();
        restoreConfig();
    }
});

test('workspace checkpoint encryption metadata round-trips from Blob metadata', (t) => {
    const metadata = workspaceClientModule.__testables.checkpointEncryptionMetadata({
        algorithm: 'aes-256-gcm',
        keyId: 'key-1',
        ivBase64: Buffer.alloc(12, 3).toString('base64'),
        tagBase64: Buffer.alloc(16, 4).toString('base64'),
        compression: 'pigz',
    });

    t.deepEqual(workspaceClientModule.__testables.checkpointEncryptionFromMetadata(metadata), {
        algorithm: 'aes-256-gcm',
        keyId: 'key-1',
        ivBase64: Buffer.alloc(12, 3).toString('base64'),
        tagBase64: Buffer.alloc(16, 4).toString('base64'),
        compression: 'pigz',
    });
});

test('encrypted streaming checkpoint requires workspace helper 1.0.10 or newer', (t) => {
    t.false(workspaceClientModule.__testables.isEncryptedStreamingCheckpointWorkspace('1.0.9'));
    t.true(workspaceClientModule.__testables.isEncryptedStreamingCheckpointWorkspace('1.0.10'));
    t.true(workspaceClientModule.__testables.isEncryptedStreamingCheckpointWorkspace('1.1.0'));
    t.true(workspaceClientModule.__testables.isEncryptedStreamingCheckpointWorkspace('2.0.0'));
});

function stubConfig(stubs) {
    const originalGet = config.get.bind(config);
    config.get = (key) => {
        if (key in stubs) return stubs[key];
        if (key === 'workspaceContainerPrefix') return 'workspace';
        return originalGet(key);
    };
    return () => {
        config.get = originalGet;
    };
}

function stubLogger() {
    const original = {
        info: logger.info,
        warn: logger.warn,
        error: logger.error,
    };
    const calls = [];

    logger.info = (message) => calls.push({ level: 'info', message });
    logger.warn = (message) => calls.push({ level: 'warn', message });
    logger.error = (message) => calls.push({ level: 'error', message });

    return {
        calls,
        restore() {
            logger.info = original.info;
            logger.warn = original.warn;
            logger.error = original.error;
        },
    };
}

function stubEntityStore(entity) {
    const entityStore = getEntityStore();
    const original = {
        isConfigured: entityStore.isConfigured,
        getEntity: entityStore.getEntity,
        getEntityByWorkspaceContainerId: entityStore.getEntityByWorkspaceContainerId,
        getDefaultEntity: entityStore.getDefaultEntity,
        getAllEntities: entityStore.getAllEntities,
        upsertEntity: entityStore.upsertEntity,
    };
    let currentEntity = entity;

    entityStore.isConfigured = () => true;
    entityStore.getEntity = async () => currentEntity;
    entityStore.getEntityByWorkspaceContainerId = async (containerId) =>
        currentEntity?.workspace?.containerId === containerId ? currentEntity : null;
    entityStore.getDefaultEntity = async () => null;
    entityStore.getAllEntities = async () => currentEntity ? [currentEntity] : [];
    entityStore.upsertEntity = async (nextEntity) => {
        currentEntity = nextEntity;
        return nextEntity;
    };

    return () => {
        entityStore.isConfigured = original.isConfigured;
        entityStore.getEntity = original.getEntity;
        entityStore.getEntityByWorkspaceContainerId = original.getEntityByWorkspaceContainerId;
        entityStore.getDefaultEntity = original.getDefaultEntity;
        entityStore.getAllEntities = original.getAllEntities;
        entityStore.upsertEntity = original.upsertEntity;
    };
}

function stubMutableEntityStore(entity) {
    const entityStore = getEntityStore();
    const original = {
        isConfigured: entityStore.isConfigured,
        getEntity: entityStore.getEntity,
        getEntityByWorkspaceContainerId: entityStore.getEntityByWorkspaceContainerId,
        getDefaultEntity: entityStore.getDefaultEntity,
        getAllEntities: entityStore.getAllEntities,
        upsertEntity: entityStore.upsertEntity,
    };
    let currentEntity = entity;

    entityStore.isConfigured = () => true;
    entityStore.getEntity = async () => currentEntity;
    entityStore.getEntityByWorkspaceContainerId = async (containerId) =>
        currentEntity?.workspace?.containerId === containerId ? currentEntity : null;
    entityStore.getDefaultEntity = async () => null;
    entityStore.getAllEntities = async () => currentEntity ? [currentEntity] : [];
    entityStore.upsertEntity = async (nextEntity) => {
        currentEntity = nextEntity;
        return nextEntity;
    };

    return {
        getEntity() {
            return currentEntity;
        },
        setEntity(nextEntity) {
            currentEntity = nextEntity;
        },
        restore() {
            entityStore.isConfigured = original.isConfigured;
            entityStore.getEntity = original.getEntity;
            entityStore.getEntityByWorkspaceContainerId = original.getEntityByWorkspaceContainerId;
            entityStore.getDefaultEntity = original.getDefaultEntity;
            entityStore.getAllEntities = original.getAllEntities;
            entityStore.upsertEntity = original.upsertEntity;
        },
    };
}

function createFakeRedis(options = {}) {
    const {
        activityTimestamp,
        acquireLock = true,
        activityIndex = {},
        hashes = {},
    } = options;
    const values = new Map();
    const zsets = new Map();
    const calls = [];

    for (const [entityId, score] of Object.entries(activityIndex)) {
        zsets.set(entityId, Number(score));
    }

    return {
        calls,
        async get(key) {
            calls.push({ op: 'get', key });
            if (key.includes(':activity:') && activityTimestamp !== undefined) {
                const value = typeof activityTimestamp === 'function'
                    ? activityTimestamp()
                    : activityTimestamp;
                return String(value);
            }
            return values.get(key) ?? null;
        },
        async set(key, value, ...args) {
            calls.push({ op: 'set', key, value, args });
            if (args.includes('NX')) {
                if (!acquireLock || values.has(key)) return null;
                values.set(key, value);
                return 'OK';
            }
            values.set(key, value);
            return 'OK';
        },
        async del(key) {
            calls.push({ op: 'del', key });
            values.delete(key);
            return 1;
        },
        async zadd(key, score, member) {
            calls.push({ op: 'zadd', key, score, member });
            zsets.set(member, Number(score));
            return 1;
        },
        async zrangebyscore(key, min, max) {
            calls.push({ op: 'zrangebyscore', key, min, max });
            const minScore = Number(min);
            const maxScore = Number(max);
            return Array.from(zsets.entries())
                .filter(([, score]) => score >= minScore && score <= maxScore)
                .map(([member]) => member);
        },
        async zrem(key, member) {
            calls.push({ op: 'zrem', key, member });
            return zsets.delete(member) ? 1 : 0;
        },
        async srem(key, member) {
            calls.push({ op: 'srem', key, member });
            return 1;
        },
        async hgetall(key) {
            calls.push({ op: 'hgetall', key });
            return hashes[key] || {};
        },
        async hdel(key, field) {
            calls.push({ op: 'hdel', key, field });
            if (!hashes[key] || !(field in hashes[key])) return 0;
            delete hashes[key][field];
            return 1;
        },
    };
}

test.serial('warmPool init uses WARM_POOL_ENABLED instead of bootstrap secret presence', async (t) => {
    const restoreConfig = stubConfig({
        warmPoolSize: 1,
        workspaceBackend: 'aci',
        warmPoolEnabled: true,
        warmPoolBootstrapSecret: '',
        storageConnectionString: '',
        cortexId: 'test-cortex',
    });
    const logCapture = stubLogger();

    try {
        await warmPoolModule.initWarmPool();

        t.true(
            logCapture.calls.some(call => call.message.includes('Redis not available')),
            'expected initWarmPool to proceed past the legacy bootstrap-secret guard'
        );
        t.false(
            logCapture.calls.some(call => call.message.includes('WARM_POOL_BOOTSTRAP_SECRET is required')),
            'warmPool should no longer require WARM_POOL_BOOTSTRAP_SECRET'
        );
    } finally {
        logCapture.restore();
        restoreConfig();
    }
});

test.serial('warmPool pool containers get unique bootstrap secrets', async (t) => {
    const restoreConfig = stubConfig({
        workspaceImage: 'cortex-workspace',
        workspaceImageVersion: '',
        workspaceCpus: '1',
        workspaceMemory: '512m',
        workspaceDiskSize: '10g',
        warmPoolBootstrapSecret: 'legacy-shared-secret',
    });
    const logCapture = stubLogger();
    const originalFetch = global.fetch;
    const originalCreateAndStart = ACIBackend.prototype.createAndStart;
    const originalRemove = ACIBackend.prototype.remove;
    const originalDestroyVolume = ACIBackend.prototype.destroyVolume;
    let createCounter = 0;

    global.fetch = async () => ({ ok: true });
    ACIBackend.prototype.createAndStart = async function ({ containerName }) {
        createCounter += 1;
        return {
            containerId: `${containerName}-id`,
            url: `http://pool-${createCounter}.test:3100`,
        };
    };
    ACIBackend.prototype.remove = async function () {};
    ACIBackend.prototype.destroyVolume = async function () {};

    const fakeRedis = {
        entries: new Map(),
        async hset(_key, field, value) {
            this.entries.set(field, JSON.parse(value));
        },
        async sadd() {},
        async srem() {},
    };

    try {
        await warmPoolModule.__testables.provisionPoolContainer(fakeRedis);
        await warmPoolModule.__testables.provisionPoolContainer(fakeRedis);

        const entries = [...fakeRedis.entries.values()];
        t.is(entries.length, 2);

        const secrets = entries.map(entry => entry.bootstrapSecret);
        t.not(secrets[0], secrets[1]);
        t.false(secrets.includes('legacy-shared-secret'));
        secrets.forEach(secret => t.regex(secret, /^[0-9a-f]{64}$/));
    } finally {
        global.fetch = originalFetch;
        ACIBackend.prototype.createAndStart = originalCreateAndStart;
        ACIBackend.prototype.remove = originalRemove;
        ACIBackend.prototype.destroyVolume = originalDestroyVolume;
        logCapture.restore();
        restoreConfig();
    }
});

test.serial('warmPool claim protects container from orphan reaper until release', async (t) => {
    const restoreConfig = stubConfig({
        workspaceImageVersion: '1.0.12',
        warmPoolSize: 0,
    });
    const originalList = ACIBackend.prototype.listWorkspaceContainers;
    const originalSetEntityTag = ACIBackend.prototype.setEntityTag;
    const containerName = 'workspace-dev-pool-claim123';
    const entityId = 'entity-claim-race';
    const redisEntries = new Map([
        [containerName, JSON.stringify({
            status: 'READY',
            containerId: containerName,
            url: 'http://pool-claim.test:3100',
            bootstrapSecret: 'bootstrap-secret',
            createdAt: new Date().toISOString(),
            imageVersion: '1.0.12',
        })],
    ]);
    const readyMembers = new Set([containerName]);
    const tagged = [];

    ACIBackend.prototype.listWorkspaceContainers = async () => [{
        name: containerName,
        tags: {
            workspaceRole: 'pool',
            imageVersion: '1.0.12',
        },
    }];
    ACIBackend.prototype.setEntityTag = async function (name, tagEntityId) {
        tagged.push({ name, tagEntityId });
    };

    const fakeRedis = {
        async spop() {
            const [member] = readyMembers;
            if (member) readyMembers.delete(member);
            return member || null;
        },
        async hget(_key, field) {
            return redisEntries.get(field) || null;
        },
        async hset(_key, field, value) {
            redisEntries.set(field, value);
            return 1;
        },
        async hdel(_key, field) {
            const existed = redisEntries.delete(field);
            return existed ? 1 : 0;
        },
        async srem(_key, member) {
            readyMembers.delete(member);
            return 1;
        },
        async hgetall() {
            return Object.fromEntries(redisEntries);
        },
    };

    try {
        const claimed = await warmPoolModule.claimContainer(entityId, fakeRedis);

        t.true(claimed.success);
        t.is(claimed.containerName, containerName);
        t.false(readyMembers.has(containerName));
        t.deepEqual(tagged, [{ name: containerName, tagEntityId: entityId }]);

        const claimedEntry = JSON.parse(redisEntries.get(containerName));
        t.is(claimedEntry.status, 'CLAIMED');
        t.is(claimedEntry.claimedByEntityId, entityId);
        t.truthy(claimedEntry.claimedAt);

        const protectedContainers = await warmPoolModule.getWarmPoolActiveContainerNames(fakeRedis);
        t.true(protectedContainers.has(containerName));

        await warmPoolModule.__testables.releaseClaimedContainer(containerName, fakeRedis);
        t.false(redisEntries.has(containerName));
    } finally {
        ACIBackend.prototype.listWorkspaceContainers = originalList;
        ACIBackend.prototype.setEntityTag = originalSetEntityTag;
        restoreConfig();
    }
});

test.serial('warmPool replenishment does not count CLAIMED containers as available capacity', async (t) => {
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        warmPoolSize: 1,
        workspaceImage: 'cortex-workspace',
        workspaceImageVersion: '1.0.12',
        workspaceCpus: '1',
        workspaceMemory: '512m',
        workspaceDiskSize: '10g',
    });
    const originalFetch = global.fetch;
    const originalList = ACIBackend.prototype.listWorkspaceContainers;
    const originalCreateAndStart = ACIBackend.prototype.createAndStart;
    const redisEntries = new Map([
        ['workspace-dev-pool-claimed', JSON.stringify({
            status: 'CLAIMED',
            containerId: 'workspace-dev-pool-claimed',
            url: 'http://claimed.test:3100',
            bootstrapSecret: 'claimed-secret',
            createdAt: new Date().toISOString(),
            claimedAt: new Date().toISOString(),
            claimedByEntityId: 'entity-claimed',
            imageVersion: '1.0.12',
        })],
    ]);
    const readyMembers = [];
    let lockOwner = null;
    let createCounter = 0;

    global.fetch = async () => ({ ok: true });
    ACIBackend.prototype.listWorkspaceContainers = async () => [{
        name: 'workspace-dev-pool-claimed',
        tags: {
            workspaceRole: 'pool',
            imageVersion: '1.0.12',
        },
    }];
    ACIBackend.prototype.createAndStart = async function ({ containerName }) {
        createCounter += 1;
        return {
            containerId: `${containerName}-id`,
            url: `http://pool-${createCounter}.test:3100`,
        };
    };

    const fakeRedis = {
        async hgetall() {
            return Object.fromEntries(redisEntries);
        },
        async hdel(_key, field) {
            const existed = redisEntries.delete(field);
            return existed ? 1 : 0;
        },
        async srem() {},
        async hset(_key, field, value) {
            redisEntries.set(field, value);
            return 1;
        },
        async sadd(_key, member) {
            readyMembers.push(member);
            return 1;
        },
        async set(_key, value) {
            lockOwner = value;
            return 'OK';
        },
        async get() {
            return lockOwner;
        },
        async del() {
            lockOwner = null;
            return 1;
        },
    };

    try {
        await warmPoolModule.__testables.replenish(fakeRedis);

        t.is(createCounter, 1);
        t.is(readyMembers.length, 1);
        t.true(redisEntries.has('workspace-dev-pool-claimed'));
        t.is(JSON.parse(redisEntries.get('workspace-dev-pool-claimed')).status, 'CLAIMED');
    } finally {
        global.fetch = originalFetch;
        ACIBackend.prototype.listWorkspaceContainers = originalList;
        ACIBackend.prototype.createAndStart = originalCreateAndStart;
        restoreConfig();
    }
});

test.serial('warmPool prunes READY entries missing from ACI inventory before counting pool size', async (t) => {
    const originalList = ACIBackend.prototype.listWorkspaceContainers;
    const logCapture = stubLogger();
    const removedReady = [];
    const redisEntries = new Map([
        ['workspace-pool-stale123', JSON.stringify({
            status: 'READY',
            containerId: 'workspace-pool-stale123',
            url: 'http://stale.test:3100',
            createdAt: '2026-05-09T21:09:31.615Z',
        })],
        ['workspace-prod-pool-live123', JSON.stringify({
            status: 'READY',
            containerId: 'workspace-prod-pool-live123',
            url: 'http://live.test:3100',
            createdAt: '2026-05-09T21:50:21.917Z',
        })],
    ]);

    ACIBackend.prototype.listWorkspaceContainers = async () => [{
        name: 'workspace-prod-pool-live123',
        tags: {
            workspaceRole: 'pool',
            workspaceContainerPrefix: 'workspace-prod',
        },
    }];

    const fakeRedis = {
        async hgetall() {
            return Object.fromEntries(redisEntries);
        },
        async hdel(_key, field) {
            const existed = redisEntries.delete(field);
            return existed ? 1 : 0;
        },
        async srem(_key, field) {
            removedReady.push(field);
        },
    };

    try {
        const pruned = await warmPoolModule.__testables.pruneStalePoolEntries(fakeRedis);

        t.is(pruned, 1);
        t.false(redisEntries.has('workspace-pool-stale123'));
        t.true(redisEntries.has('workspace-prod-pool-live123'));
        t.deepEqual(removedReady, ['workspace-pool-stale123']);
        t.true(logCapture.calls.some(call =>
            call.level === 'warn' &&
            call.message.includes('Removed stale READY entry workspace-pool-stale123')
        ));
    } finally {
        ACIBackend.prototype.listWorkspaceContainers = originalList;
        logCapture.restore();
    }
});

test.serial('warmPool replenishment recovers when stale PROVISIONING entries fill the target size', async (t) => {
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        warmPoolSize: 2,
        workspaceImage: 'cortex-workspace',
        workspaceImageVersion: '1.0.12',
        workspaceCpus: '1',
        workspaceMemory: '512m',
        workspaceDiskSize: '10g',
    });
    const logCapture = stubLogger();
    const originalFetch = global.fetch;
    const originalList = ACIBackend.prototype.listWorkspaceContainers;
    const originalCreateAndStart = ACIBackend.prototype.createAndStart;
    const originalRemove = ACIBackend.prototype.remove;
    const staleCreatedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const redisEntries = new Map([
        ['workspace-pool-stuck1', JSON.stringify({
            status: 'PROVISIONING',
            containerId: 'workspace-pool-stuck1',
            createdAt: staleCreatedAt,
        })],
        ['workspace-pool-stuck2', JSON.stringify({
            status: 'PROVISIONING',
            containerId: 'workspace-pool-stuck2',
            createdAt: staleCreatedAt,
        })],
    ]);
    const readyMembers = [];
    const removedContainers = [];
    let lockOwner = null;
    let createCounter = 0;

    global.fetch = async () => ({ ok: true });
    ACIBackend.prototype.listWorkspaceContainers = async () => [];
    ACIBackend.prototype.remove = async function (_containerId, containerName) {
        removedContainers.push(containerName);
    };
    ACIBackend.prototype.createAndStart = async function ({ containerName }) {
        createCounter += 1;
        return {
            containerId: `${containerName}-id`,
            url: `http://pool-${createCounter}.test:3100`,
        };
    };

    const fakeRedis = {
        async hgetall() {
            return Object.fromEntries(redisEntries);
        },
        async hdel(_key, field) {
            const existed = redisEntries.delete(field);
            return existed ? 1 : 0;
        },
        async srem() {},
        async hset(_key, field, value) {
            redisEntries.set(field, value);
            return 1;
        },
        async sadd(_key, member) {
            readyMembers.push(member);
            return 1;
        },
        async set(_key, value) {
            lockOwner = value;
            return 'OK';
        },
        async get() {
            return lockOwner;
        },
        async del() {
            lockOwner = null;
            return 1;
        },
    };

    try {
        await warmPoolModule.__testables.replenish(fakeRedis);

        t.false(redisEntries.has('workspace-pool-stuck1'));
        t.false(redisEntries.has('workspace-pool-stuck2'));
        t.deepEqual(removedContainers.sort(), ['workspace-pool-stuck1', 'workspace-pool-stuck2']);
        t.is(createCounter, 2);
        t.is(readyMembers.length, 2);
        t.true([...redisEntries.values()].every(raw => JSON.parse(raw).status === 'READY'));
        t.true(logCapture.calls.some(call =>
            call.level === 'warn' &&
            call.message.includes('Removing stuck PROVISIONING container workspace-pool-stuck1')
        ));
    } finally {
        global.fetch = originalFetch;
        ACIBackend.prototype.listWorkspaceContainers = originalList;
        ACIBackend.prototype.createAndStart = originalCreateAndStart;
        ACIBackend.prototype.remove = originalRemove;
        logCapture.restore();
        restoreConfig();
    }
});

test.serial('warmPool rejects READY pool containers with stale image tags', async (t) => {
    const restoreConfig = stubConfig({
        workspaceImageVersion: '1.0.9',
    });

    try {
        const result = warmPoolModule.__testables.validatePoolContainerInventoryEntry(
            'workspace-local-pool-stale',
            {
                available: true,
                containersByName: new Map([[
                    'workspace-local-pool-stale',
                    {
                        name: 'workspace-local-pool-stale',
                        tags: {
                            workspaceRole: 'pool',
                            imageVersion: '1.0.8',
                        },
                    },
                ]]),
            },
            {
                status: 'READY',
                imageVersion: '1.0.8',
            },
        );

        t.false(result.valid);
        t.true(result.removeContainer);
        t.is(result.reason, 'stale image (1.0.8 vs 1.0.9)');
    } finally {
        restoreConfig();
    }
});

test.serial('createGenericContainer generates a unique bootstrap secret', async (t) => {
    const restoreConfig = stubConfig({
        workspaceImage: 'cortex-workspace',
        workspaceImageVersion: '',
        workspaceCpus: '1',
        workspaceMemory: '512m',
        workspaceDiskSize: '10g',
        warmPoolBootstrapSecret: 'legacy-shared-secret',
    });
    const originalFetch = global.fetch;
    const captured = {};

    global.fetch = async () => ({ ok: true });

    const backend = {
        backendName: 'docker',
        healthTimeoutMs: 1,
        async createAndStart(args) {
            Object.assign(captured, args);
            return { containerId: 'container-123', url: 'http://workspace.test:3100' };
        },
    };

    try {
        const result = await workspaceClientModule.__testables.createGenericContainer('entity-123', backend);

        t.regex(result.bootstrapSecret, /^[0-9a-f]{64}$/);
        t.not(result.bootstrapSecret, 'legacy-shared-secret');
        t.true(captured.env.includes(`WORKSPACE_SECRET=${result.bootstrapSecret}`));
        t.false(captured.env.includes('WORKSPACE_SECRET=legacy-shared-secret'));
    } finally {
        global.fetch = originalFetch;
        restoreConfig();
    }
});

test.serial('createGenericContainer uses configured workspace container prefix', async (t) => {
    const restoreConfig = stubConfig({
        workspaceImage: 'cortex-workspace',
        workspaceImageVersion: '',
        workspaceCpus: '1',
        workspaceMemory: '512m',
        workspaceDiskSize: '10g',
        workspaceContainerPrefix: 'workspace-dev',
    });
    const originalFetch = global.fetch;
    const captured = {};

    global.fetch = async () => ({ ok: true });

    const backend = {
        backendName: 'aci',
        healthTimeoutMs: 1,
        async createAndStart(args) {
            Object.assign(captured, args);
            return { containerId: args.containerName, url: 'http://workspace.test:3100' };
        },
    };

    try {
        const result = await workspaceClientModule.__testables.createGenericContainer('entity-123', backend);

        t.is(captured.containerName, 'workspace-dev-entity-123');
        t.is(captured.shareName, null);
        t.false(captured.mountAzureFiles);
        t.is(captured.tags.workspaceRole, 'entity');
        t.is(captured.tags.entityId, 'entity-123');
        t.is(result.containerName, 'workspace-dev-entity-123');
    } finally {
        global.fetch = originalFetch;
        restoreConfig();
    }
});

test.serial('createGenericContainer retries with unique runtime name on Azure cross-region name conflict', async (t) => {
    const restoreConfig = stubConfig({
        workspaceImage: 'cortex-workspace',
        workspaceImageVersion: '',
        workspaceCpus: '1',
        workspaceMemory: '512m',
        workspaceDiskSize: '10g',
    });
    const originalFetch = global.fetch;
    const attempts = [];

    global.fetch = async () => ({ ok: true });

    const backend = {
        backendName: 'aci',
        healthTimeoutMs: 1,
        async createAndStart(args) {
            attempts.push(args);
            if (attempts.length === 1) {
                throw new Error(
                    "The resource 'workspace-entity-123' already exists in location 'qatarcentral' in resource group 'Archipelago-ML-Experimentation'. A resource with the same name cannot be created in location 'eastus'. Please select a new resource name."
                );
            }
            return {
                containerId: args.containerName,
                url: 'http://workspace.test:3100',
            };
        },
    };

    try {
        const result = await workspaceClientModule.__testables.createGenericContainer(
            'entity-123',
            backend,
            { shareName: 'workspace-entity-123', mountAzureFiles: true },
        );

        t.is(attempts.length, 2);
        t.is(attempts[0].containerName, 'workspace-entity-123');
        t.regex(attempts[1].containerName, /^workspace-entity-123-[0-9a-f]{6}$/);
        t.is(attempts[0].shareName, 'workspace-entity-123');
        t.is(attempts[1].shareName, 'workspace-entity-123');
        t.is(result.containerName, attempts[1].containerName);
        t.is(result.containerId, attempts[1].containerName);
        t.is(result.shareName, 'workspace-entity-123');
    } finally {
        global.fetch = originalFetch;
        restoreConfig();
    }
});

test.serial('reapIdleWorkspaces destroys old orphan ACI inventory containers', async (t) => {
    const now = 10_000_000;
    const fakeRedis = createFakeRedis();
    const restoreConfig = stubConfig({
        azureAcrServer: '',
        cortexId: 'test-cortex',
        storageConnectionString: 'redis://test',
        workspaceBackend: 'aci',
        workspaceImage: 'cortex-workspace',
        workspaceImageVersion: '1.0.7',
        workspaceIdleTimeoutMs: 30 * 60 * 1000,
        workspaceContainerPrefix: 'workspace-dev',
    });
    const restoreEntityStore = stubEntityStore(null);
    const originalList = ACIBackend.prototype.listWorkspaceContainers;
    const originalRemove = ACIBackend.prototype.remove;
    const originalNow = Date.now;
    const removed = [];

    workspaceClientModule.__testables.resetActivityStateForTest();
    workspaceClientModule.__testables.setActivityRedisClientForTest(fakeRedis);

    Date.now = () => now;
    ACIBackend.prototype.listWorkspaceContainers = async () => [{
        name: 'workspace-dev-orphan-123',
        image: 'cortex-workspace:1.0.7',
        tags: { createdAt: new Date(now - 10 * 60 * 1000).toISOString() },
    }];
    ACIBackend.prototype.remove = async (_containerId, containerName) => {
        removed.push(containerName);
    };

    try {
        await workspaceClientModule.__testables.reapIdleWorkspaces();

        t.deepEqual(removed, ['workspace-dev-orphan-123']);
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        Date.now = originalNow;
        ACIBackend.prototype.listWorkspaceContainers = originalList;
        ACIBackend.prototype.remove = originalRemove;
        restoreEntityStore();
        restoreConfig();
    }
});

test.serial('reapIdleWorkspaces does not destroy inventory containers when entity lookup fails', async (t) => {
    const now = 10_000_000;
    const fakeRedis = createFakeRedis();
    const restoreConfig = stubConfig({
        azureAcrServer: '',
        cortexId: 'test-cortex',
        storageConnectionString: 'redis://test',
        workspaceBackend: 'aci',
        workspaceImage: 'cortex-workspace',
        workspaceImageVersion: '1.0.7',
        workspaceIdleTimeoutMs: 30 * 60 * 1000,
        workspaceContainerPrefix: 'workspace-dev',
    });
    const restoreEntityStore = stubEntityStore(null);
    const entityStore = getEntityStore();
    entityStore.getEntityByWorkspaceContainerId = async () => {
        throw new Error('mongo unavailable');
    };
    const originalList = ACIBackend.prototype.listWorkspaceContainers;
    const originalRemove = ACIBackend.prototype.remove;
    const originalNow = Date.now;
    const logCapture = stubLogger();
    let removeCalled = false;

    workspaceClientModule.__testables.resetActivityStateForTest();
    workspaceClientModule.__testables.setActivityRedisClientForTest(fakeRedis);

    Date.now = () => now;
    ACIBackend.prototype.listWorkspaceContainers = async () => [{
        name: 'workspace-dev-lookup-failure',
        image: 'cortex-workspace:1.0.7',
        tags: {
            createdAt: new Date(now - 10 * 60 * 1000).toISOString(),
            entityId: 'entity-lookup-failure',
        },
    }];
    ACIBackend.prototype.remove = async () => {
        removeCalled = true;
    };

    try {
        await workspaceClientModule.__testables.reapIdleWorkspaces();

        t.false(removeCalled);
        const reaperLog = logCapture.calls
            .map(call => call.message)
            .find(message => message.startsWith('[WorkspaceReaper]'));
        t.truthy(reaperLog);
        const decision = JSON.parse(reaperLog.slice('[WorkspaceReaper] '.length));
        t.is(decision.action, 'skip');
        t.is(decision.reason, 'entity-lookup-failed');
        t.true(decision.entityLookupFailed);
    } finally {
        logCapture.restore();
        workspaceClientModule.__testables.resetActivityStateForTest();
        Date.now = originalNow;
        ACIBackend.prototype.listWorkspaceContainers = originalList;
        ACIBackend.prototype.remove = originalRemove;
        restoreEntityStore();
        restoreConfig();
    }
});

test.serial('reapIdleWorkspaces uses entityId inventory tag when containerId lookup misses', async (t) => {
    const now = 10_000_000;
    const entityId = 'entity-tag-fallback';
    const freshActivity = now - 1000;
    const fakeRedis = createFakeRedis({
        activityTimestamp: freshActivity,
    });
    const restoreConfig = stubConfig({
        azureAcrServer: '',
        cortexId: 'test-cortex',
        storageConnectionString: 'redis://test',
        workspaceBackend: 'aci',
        workspaceImage: 'cortex-workspace',
        workspaceImageVersion: '1.0.7',
        workspaceIdleTimeoutMs: 30 * 60 * 1000,
        workspaceContainerPrefix: 'workspace-dev',
    });
    const restoreEntityStore = stubEntityStore({
        id: entityId,
        workspace: {
            containerId: 'workspace-dev-current-container',
            status: 'stopped',
            checkpointBlobPath: workspaceClientModule.__testables.workspaceCheckpointBlobPath(entityId),
            checkpointedAt: new Date(freshActivity).toISOString(),
        },
    });
    const entityStore = getEntityStore();
    entityStore.getEntityByWorkspaceContainerId = async () => null;
    const originalList = ACIBackend.prototype.listWorkspaceContainers;
    const originalRemove = ACIBackend.prototype.remove;
    const originalNow = Date.now;
    let removeCalled = false;

    workspaceClientModule.__testables.resetActivityStateForTest();
    workspaceClientModule.__testables.setActivityRedisClientForTest(fakeRedis);

    Date.now = () => now;
    ACIBackend.prototype.listWorkspaceContainers = async () => [{
        name: 'workspace-dev-current-container',
        image: 'cortex-workspace:1.0.7',
        tags: {
            createdAt: new Date(now - 10 * 60 * 1000).toISOString(),
            entityId,
        },
    }];
    ACIBackend.prototype.remove = async () => {
        removeCalled = true;
    };

    try {
        await workspaceClientModule.__testables.reapIdleWorkspaces();

        t.false(removeCalled);
        t.true(fakeRedis.calls.some(call => call.op === 'get' && call.key.endsWith(`:activity:${entityId}`)));
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        Date.now = originalNow;
        ACIBackend.prototype.listWorkspaceContainers = originalList;
        ACIBackend.prototype.remove = originalRemove;
        restoreEntityStore();
        restoreConfig();
    }
});

test.serial('reapIdleWorkspaces treats stale entityId inventory tags as orphan containers', async (t) => {
    const now = 10_000_000;
    const entityId = 'entity-stale-tag';
    const oldActivity = now - 60 * 60 * 1000;
    const staleContainerName = 'workspace-dev-stale-container';
    const currentContainerName = 'workspace-dev-current-container';
    const fakeRedis = createFakeRedis({
        activityTimestamp: oldActivity,
    });
    const restoreConfig = stubConfig({
        azureAcrServer: '',
        cortexId: 'test-cortex',
        storageConnectionString: 'redis://test',
        workspaceBackend: 'aci',
        workspaceImage: 'cortex-workspace',
        workspaceImageVersion: '1.0.7',
        workspaceIdleTimeoutMs: 30 * 60 * 1000,
        workspaceContainerPrefix: 'workspace-dev',
    });
    const restoreEntityStore = stubEntityStore({
        id: entityId,
        workspace: {
            containerId: currentContainerName,
            status: 'stopped',
            checkpointBlobPath: workspaceClientModule.__testables.workspaceCheckpointBlobPath(entityId),
            checkpointedAt: new Date(oldActivity + 1000).toISOString(),
        },
    });
    const originalList = ACIBackend.prototype.listWorkspaceContainers;
    const originalRemove = ACIBackend.prototype.remove;
    const originalNow = Date.now;
    const removed = [];

    workspaceClientModule.__testables.resetActivityStateForTest();
    workspaceClientModule.__testables.setActivityRedisClientForTest(fakeRedis);

    Date.now = () => now;
    ACIBackend.prototype.listWorkspaceContainers = async () => [{
        name: staleContainerName,
        image: 'cortex-workspace:1.0.7',
        tags: {
            createdAt: new Date(now - 10 * 60 * 1000).toISOString(),
            entityId,
        },
    }];
    ACIBackend.prototype.remove = async (_containerId, containerName) => {
        removed.push(containerName);
    };

    try {
        await workspaceClientModule.__testables.reapIdleWorkspaces();

        t.deepEqual(removed, [staleContainerName]);
        t.false(fakeRedis.calls.some(call => call.op === 'get' && call.key.endsWith(`:activity:${entityId}`)));
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        Date.now = originalNow;
        ACIBackend.prototype.listWorkspaceContainers = originalList;
        ACIBackend.prototype.remove = originalRemove;
        restoreEntityStore();
        restoreConfig();
    }
});

test.serial('reapIdleWorkspaces skips active warm-pool inventory containers', async (t) => {
    const now = 10_000_000;
    const poolName = 'workspace-dev-pool-abc123';
    const fakeRedis = createFakeRedis({
        hashes: {
            'test-cortex-warmpool:containers': {
                [poolName]: JSON.stringify({
                    status: 'READY',
                    createdAt: new Date(now - 10 * 60 * 1000).toISOString(),
                }),
            },
        },
    });
    const restoreConfig = stubConfig({
        azureAcrServer: '',
        cortexId: 'test-cortex',
        storageConnectionString: 'redis://test',
        workspaceBackend: 'aci',
        workspaceImage: 'cortex-workspace',
        workspaceImageVersion: '1.0.7',
        workspaceIdleTimeoutMs: 30 * 60 * 1000,
        workspaceContainerPrefix: 'workspace-dev',
    });
    const restoreEntityStore = stubEntityStore(null);
    const originalList = ACIBackend.prototype.listWorkspaceContainers;
    const originalRemove = ACIBackend.prototype.remove;
    const originalNow = Date.now;
    let removeCalled = false;

    workspaceClientModule.__testables.resetActivityStateForTest();
    workspaceClientModule.__testables.setActivityRedisClientForTest(fakeRedis);

    Date.now = () => now;
    ACIBackend.prototype.listWorkspaceContainers = async () => [{
        name: poolName,
        image: 'cortex-workspace:1.0.7',
        tags: { createdAt: new Date(now - 10 * 60 * 1000).toISOString() },
    }];
    ACIBackend.prototype.remove = async () => {
        removeCalled = true;
    };

    try {
        await workspaceClientModule.__testables.reapIdleWorkspaces();

        t.false(removeCalled);
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        Date.now = originalNow;
        ACIBackend.prototype.listWorkspaceContainers = originalList;
        ACIBackend.prototype.remove = originalRemove;
        restoreEntityStore();
        restoreConfig();
    }
});

test.serial('reapIdleWorkspaces ignores stale warm-pool registry for assigned containers', async (t) => {
    const now = 10_000_000;
    const oldActivity = now - 60 * 60 * 1000;
    const containerName = 'workspace-dev-pool-claimed';
    const fakeRedis = createFakeRedis({
        activityTimestamp: oldActivity,
        hashes: {
            'test-cortex-warmpool:containers': {
                [containerName]: JSON.stringify({
                    status: 'READY',
                    createdAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
                }),
            },
        },
    });
    const entity = {
        id: 'entity-assigned',
        workspace: {
            containerId: containerName,
            status: 'stopped',
            checkpointBlobPath: 'workspace-checkpoints/test/entity-assigned/workspace.tar.gz',
            checkpointedAt: new Date(oldActivity + 1000).toISOString(),
        },
    };
    const restoreConfig = stubConfig({
        azureAcrServer: '',
        cortexId: 'test-cortex',
        storageConnectionString: 'redis://test',
        workspaceBackend: 'aci',
        workspaceImage: 'cortex-workspace',
        workspaceImageVersion: '1.0.7',
        workspaceIdleTimeoutMs: 30 * 60 * 1000,
        workspaceContainerPrefix: 'workspace-dev',
    });
    const restoreEntityStore = stubEntityStore(entity);
    const originalList = ACIBackend.prototype.listWorkspaceContainers;
    const originalRemove = ACIBackend.prototype.remove;
    const originalNow = Date.now;
    const removed = [];

    workspaceClientModule.__testables.resetActivityStateForTest();
    workspaceClientModule.__testables.setActivityRedisClientForTest(fakeRedis);

    Date.now = () => now;
    ACIBackend.prototype.listWorkspaceContainers = async () => [{
        name: containerName,
        image: 'cortex-workspace:1.0.7',
        tags: { createdAt: new Date(now - 2 * 60 * 60 * 1000).toISOString() },
    }];
    ACIBackend.prototype.remove = async (_containerId, name) => {
        removed.push(name);
    };

    try {
        await workspaceClientModule.__testables.reapIdleWorkspaces();

        t.deepEqual(removed, [containerName]);
        t.true(fakeRedis.calls.some(call =>
            call.op === 'hdel' &&
            call.key === 'test-cortex-warmpool:containers' &&
            call.field === containerName
        ));
        t.true(fakeRedis.calls.some(call =>
            call.op === 'srem' &&
            call.key === 'test-cortex-warmpool:ready' &&
            call.member === containerName
        ));
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        Date.now = originalNow;
        ACIBackend.prototype.listWorkspaceContainers = originalList;
        ACIBackend.prototype.remove = originalRemove;
        restoreEntityStore();
        restoreConfig();
    }
});

test.serial('reapIdleWorkspaces skips prefix-matching containers without Cortex ownership proof', async (t) => {
    const now = 10_000_000;
    const fakeRedis = createFakeRedis();
    const restoreConfig = stubConfig({
        azureAcrServer: '',
        cortexId: 'test-cortex',
        storageConnectionString: 'redis://test',
        workspaceBackend: 'aci',
        workspaceImage: 'cortex-workspace',
        workspaceImageVersion: '1.0.7',
        workspaceIdleTimeoutMs: 30 * 60 * 1000,
        workspaceContainerPrefix: 'workspace',
    });
    const restoreEntityStore = stubEntityStore(null);
    const originalList = ACIBackend.prototype.listWorkspaceContainers;
    const originalRemove = ACIBackend.prototype.remove;
    const originalNow = Date.now;
    let removeCalled = false;

    workspaceClientModule.__testables.resetActivityStateForTest();
    workspaceClientModule.__testables.setActivityRedisClientForTest(fakeRedis);

    Date.now = () => now;
    ACIBackend.prototype.listWorkspaceContainers = async () => [{
        name: 'workspace-foo',
        image: 'ubuntu:latest',
        tags: { createdAt: new Date(now - 10 * 60 * 1000).toISOString() },
    }];
    ACIBackend.prototype.remove = async () => {
        removeCalled = true;
    };

    try {
        await workspaceClientModule.__testables.reapIdleWorkspaces();

        t.false(removeCalled);
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        Date.now = originalNow;
        ACIBackend.prototype.listWorkspaceContainers = originalList;
        ACIBackend.prototype.remove = originalRemove;
        restoreEntityStore();
        restoreConfig();
    }
});

test.serial('createGenericContainer does not invent ACI share names when first container name conflicts', async (t) => {
    const restoreConfig = stubConfig({
        workspaceImage: 'cortex-workspace',
        workspaceImageVersion: '',
        workspaceCpus: '1',
        workspaceMemory: '512m',
        workspaceDiskSize: '10g',
    });
    const originalFetch = global.fetch;
    const attempts = [];

    global.fetch = async () => ({ ok: true });

    const backend = {
        backendName: 'aci',
        healthTimeoutMs: 1,
        async createAndStart(args) {
            attempts.push(args);
            if (attempts.length === 1) {
                throw new Error(
                    "The resource 'workspace-entity-456' already exists in location 'qatarcentral' in resource group 'Archipelago-ML-Experimentation'. A resource with the same name cannot be created in location 'eastus'. Please select a new resource name."
                );
            }
            return {
                containerId: args.containerName,
                url: 'http://workspace.test:3100',
            };
        },
    };

    try {
        const result = await workspaceClientModule.__testables.createGenericContainer('entity-456', backend);

        t.is(attempts.length, 2);
        t.is(attempts[0].shareName, null);
        t.is(attempts[1].shareName, null);
        t.is(result.shareName, null);
    } finally {
        global.fetch = originalFetch;
        restoreConfig();
    }
});

test.serial('workspaceRequest waits for an in-progress workspace transition before sending request', async (t) => {
    const entityId = 'entity-transition-wait';
    const store = stubMutableEntityStore({
        id: entityId,
        name: 'Transition Wait Entity',
        workspace: {
            status: 'provisioning',
            provisionedAt: new Date(),
        },
    });
    const originalFetch = global.fetch;
    let fetchUrl = null;
    const lifecycleEvents = [];

    global.fetch = async (url, options) => {
        fetchUrl = url;
        t.is(options.headers['x-workspace-secret'], 'secret-ready');
        return {
            ok: true,
            status: 200,
            async json() {
                return { status: 'ok' };
            },
        };
    };

    const timer = setTimeout(() => {
        store.setEntity({
            id: entityId,
            name: 'Transition Wait Entity',
            workspace: {
                status: 'running',
                url: 'http://workspace-ready.test:3100',
                secret: 'secret-ready',
                provisionedAt: new Date(),
            },
        });
    }, 25);

    try {
        const result = await workspaceClientModule.workspaceRequest(entityId, '/health', null, {
            transitionWaitMs: 500,
            transitionPollMs: 10,
            onWorkspaceLifecycle(event) {
                lifecycleEvents.push(event);
            },
        });

        t.true(result.success);
        t.is(result.status, 'ok');
        t.is(fetchUrl, 'http://workspace-ready.test:3100/health');
        t.deepEqual(
            lifecycleEvents.map(({ type, phase, message, success }) => ({ type, phase, message, success })),
            [
                {
                    type: 'start',
                    phase: 'provision',
                    message: 'Waiting for workspace setup',
                    success: undefined,
                },
                {
                    type: 'finish',
                    phase: 'provision',
                    message: undefined,
                    success: true,
                },
            ],
        );
    } finally {
        clearTimeout(timer);
        global.fetch = originalFetch;
        store.restore();
    }
});

test.serial('workspaceRequest waits when another worker owns the provisioning lock', async (t) => {
    const entityId = 'entity-peer-provision';
    const store = stubMutableEntityStore({
        id: entityId,
        name: 'Peer Provision Entity',
        workspace: null,
    });
    const fakeRedis = createFakeRedis({ acquireLock: false });
    const originalFetch = global.fetch;
    let fetchUrl = null;

    workspaceClientModule.__testables.resetActivityStateForTest();
    workspaceClientModule.__testables.setActivityRedisClientForTest(fakeRedis);

    global.fetch = async (url, options) => {
        fetchUrl = url;
        t.is(options.headers['x-workspace-secret'], 'peer-secret');
        return {
            ok: true,
            status: 200,
            async json() {
                return { status: 'ok' };
            },
        };
    };

    const timer = setTimeout(() => {
        store.setEntity({
            id: entityId,
            name: 'Peer Provision Entity',
            workspace: {
                status: 'running',
                url: 'http://peer-ready.test:3100',
                secret: 'peer-secret',
                provisionedAt: new Date(),
            },
        });
    }, 25);

    try {
        const result = await workspaceClientModule.workspaceRequest(entityId, '/health', null, {
            transitionWaitMs: 500,
            transitionPollMs: 10,
        });

        t.true(result.success);
        t.is(fetchUrl, 'http://peer-ready.test:3100/health');
        t.true(fakeRedis.calls.some(call =>
            call.op === 'set' &&
            call.key.includes('workspace:provisioning-lock:entity-peer-provision') &&
            call.args.includes('NX')
        ));
    } finally {
        clearTimeout(timer);
        global.fetch = originalFetch;
        workspaceClientModule.__testables.resetActivityStateForTest();
        store.restore();
    }
});

test.serial('reconfigureForEntity skips cleanup for existing workspaces when destroyOnFailure is false', async (t) => {
    const originalFetch = global.fetch;
    let removeCalled = false;

    global.fetch = async () => {
        throw new Error('fetch failed');
    };

    const backend = {
        backendName: 'docker',
        async remove() {
            removeCalled = true;
        },
    };

    try {
        await t.throwsAsync(
            () => workspaceClientModule.__testables.reconfigureForEntity(
                'entity-123',
                { secrets: null },
                {
                    containerName: 'workspace-entity-123',
                    shareName: 'workspace-entity-123',
                    url: 'http://wrong-host:3100',
                    bootstrapSecret: 'bootstrap-secret',
                    containerId: 'workspace-entity-123',
                    claimedFromPool: false,
                },
                backend,
                { destroyOnFailure: false },
            ),
            { message: 'fetch failed' },
        );

        t.false(removeCalled);
    } finally {
        global.fetch = originalFetch;
    }
});

test.serial('reconfigureForEntity still cleans up failed disposable containers by default', async (t) => {
    const originalFetch = global.fetch;
    const removeCalls = [];

    global.fetch = async () => {
        throw new Error('fetch failed');
    };

    const backend = {
        backendName: 'docker',
        async remove(containerId, containerName) {
            removeCalls.push({ containerId, containerName });
        },
    };

    try {
        await t.throwsAsync(
            () => workspaceClientModule.__testables.reconfigureForEntity(
                'entity-123',
                { secrets: null },
                {
                    containerName: 'workspace-entity-123',
                    shareName: 'workspace-entity-123',
                    url: 'http://wrong-host:3100',
                    bootstrapSecret: 'bootstrap-secret',
                    containerId: 'workspace-entity-123',
                    claimedFromPool: false,
                },
                backend,
            ),
            { message: 'fetch failed' },
        );

        t.deepEqual(removeCalls, [{
            containerId: 'workspace-entity-123',
            containerName: 'workspace-entity-123',
        }]);
    } finally {
        global.fetch = originalFetch;
    }
});

test.serial('reconfigureForEntity records the actual claimed container image version', async (t) => {
    const originalFetch = global.fetch;
    const restoreConfig = stubConfig({
        workspaceImageVersion: '1.0.9',
    });
    const store = stubMutableEntityStore({
        id: 'entity-claimed-stale-image',
        secrets: null,
    });

    global.fetch = async (url, options = {}) => {
        t.is(url, 'http://workspace.test:3100/reconfigure');
        t.is(options.headers?.['x-workspace-secret'], 'bootstrap-secret');
        return {
            ok: true,
            status: 200,
            async json() {
                return { success: true };
            },
        };
    };

    try {
        await workspaceClientModule.__testables.reconfigureForEntity(
            'entity-claimed-stale-image',
            store.getEntity(),
            {
                containerName: 'workspace-local-pool-stale',
                url: 'http://workspace.test:3100',
                bootstrapSecret: 'bootstrap-secret',
                containerId: 'workspace-local-pool-stale',
                claimedFromPool: true,
                imageVersion: '1.0.8',
            },
            { backendName: 'docker' },
        );

        t.is(store.getEntity().workspace.imageVersion, '1.0.8');
        t.true(store.getEntity().workspace.claimedFromPool);
    } finally {
        global.fetch = originalFetch;
        store.restore();
        restoreConfig();
    }
});

test.serial('ACIBackend stop calls Azure container group stop', async (t) => {
    const restoreConfig = stubConfig({
        azureResourceGroup: 'test-rg',
    });
    const backend = new ACIBackend();
    const calls = [];

    backend._getClient = async () => ({
        containerGroups: {
            async stop(resourceGroup, groupName) {
                calls.push({ resourceGroup, groupName });
            },
        },
    });

    try {
        await backend.stop('container-id', 'workspace-entity-123');

        t.deepEqual(calls, [{
            resourceGroup: 'test-rg',
            groupName: 'workspace-entity-123',
        }]);
    } finally {
        restoreConfig();
    }
});

test.serial('ACIBackend start waits for Azure start and returns current private-IP URL', async (t) => {
    const restoreConfig = stubConfig({
        azureResourceGroup: 'test-rg',
    });
    const backend = new ACIBackend();
    const calls = [];

    backend._getClient = async () => ({
        containerGroups: {
            async beginStart(resourceGroup, groupName) {
                calls.push({ method: 'beginStart', resourceGroup, groupName });
                return {
                    async pollUntilDone() {
                        calls.push({ method: 'pollUntilDone' });
                    },
                };
            },
            async get(resourceGroup, groupName) {
                calls.push({ method: 'get', resourceGroup, groupName });
                return {
                    ipAddress: {
                        ip: '10.1.2.3',
                    },
                };
            },
        },
    });

    try {
        const result = await backend.start('container-id', 'workspace-entity-123');

        t.is(result.url, 'http://10.1.2.3:3100');
        t.deepEqual(calls, [
            { method: 'beginStart', resourceGroup: 'test-rg', groupName: 'workspace-entity-123' },
            { method: 'pollUntilDone' },
            { method: 'get', resourceGroup: 'test-rg', groupName: 'workspace-entity-123' },
        ]);
    } finally {
        restoreConfig();
    }
});

test.serial('ACIBackend wake timeout matches create timeout for real starts', (t) => {
    const backend = new ACIBackend();

    t.is(backend.wakeHealthTimeoutMs, backend.healthTimeoutMs);
});

test.serial('ACIBackend createAndStart requires private subnet outside local environments', async (t) => {
    const restoreConfig = stubConfig({
        env: 'production',
        aciSubnetId: '',
        azureResourceGroup: 'test-rg',
    });
    const backend = new ACIBackend();

    backend._getClient = async () => {
        t.fail('createAndStart should fail before creating an Azure client');
    };

    try {
        await t.throwsAsync(
            () => backend.createAndStart({
                containerName: 'workspace-entity-123',
                image: 'cortex-workspace:latest',
                env: ['WORKSPACE_SECRET=test'],
                cpus: 1,
                memoryMB: 512,
                diskSize: '10g',
            }),
            { message: 'ACI_SUBNET_ID is required for ACI workspaces outside development/test/local environments' },
        );
    } finally {
        restoreConfig();
    }
});

test.serial('ACIBackend createAndStart allows public local debug workspaces without subnet', async (t) => {
    const restoreConfig = stubConfig({
        env: 'debug',
        aciSubnetId: '',
        azureResourceGroup: 'test-rg',
        azureLocation: 'eastus',
        azureAcrServer: '',
        cortexId: 'test-cortex',
        workspaceContainerPrefix: 'workspace-local',
        workspaceImageVersion: '1.0.9',
    });
    const backend = new ACIBackend();
    let createCall = null;

    backend._getClient = async () => ({
        containerGroups: {
            async beginCreateOrUpdate(resourceGroup, containerName, definition) {
                createCall = { resourceGroup, containerName, definition };
                return {
                    async pollUntilDone() {
                        return { ipAddress: { ip: '1.2.3.4' } };
                    },
                };
            },
        },
    });

    try {
        const result = await backend.createAndStart({
            containerName: 'workspace-local-entity-123',
            image: 'cortex-workspace:1.0.9',
            env: ['WORKSPACE_SECRET=test'],
            cpus: 1,
            memoryMB: 512,
            diskSize: '10g',
        });

        t.is(result.url, 'http://1.2.3.4:3100');
        t.is(createCall.definition.restartPolicy, 'Never');
        t.is(createCall.definition.ipAddress.type, 'Public');
        t.false(Object.hasOwn(createCall.definition, 'subnetIds'));
    } finally {
        restoreConfig();
    }
});

test.serial('workspaceUploadFile wakes stopped ACI workspace before streaming upload', async (t) => {
    const restoreConfig = stubConfig({
        workspaceBackend: 'aci',
        workspaceImageVersion: '',
        redisEncryptionKey: 'test-key',
    });
    const restoreEntityStore = stubEntityStore({
        id: 'entity-123',
        secrets: {},
        workspace: {
            url: 'http://stopped.test:3100',
            secret: 'secret-123',
            bootstrapSecret: 'bootstrap-secret',
            containerId: 'workspace-entity-123',
            shareName: 'workspace-entity-123',
            status: 'stopped',
        },
    });
    const originalFetch = global.fetch;
    const originalStart = ACIBackend.prototype.start;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-upload-wake-'));
    const tempFile = path.join(tempDir, 'archive.tar.gz');
    const fetchCalls = [];
    const startCalls = [];
    let rotatedSecret = null;

    fs.writeFileSync(tempFile, 'backup');

    ACIBackend.prototype.start = async function (containerId, containerName) {
        startCalls.push({ containerId, containerName });
        return { url: 'http://woken.test:3100' };
    };

    global.fetch = async (url, options = {}) => {
        fetchCalls.push({ url, method: options.method || 'GET' });
        const { pathname, hostname } = new URL(url);

        if (pathname === '/health') {
            t.is(hostname, 'woken.test');
            return { ok: true };
        }

        if (pathname === '/reconfigure') {
            t.is(hostname, 'woken.test');
            t.is(options.headers['x-workspace-secret'], 'bootstrap-secret');
            const body = JSON.parse(options.body);
            t.regex(body.secret, /^[0-9a-f]{64}$/);
            t.not(body.secret, 'secret-123');
            t.deepEqual(body.env, {});
            rotatedSecret = body.secret;
            return {
                ok: true,
                status: 200,
                async json() {
                    return { success: true };
                },
            };
        }

        if (pathname === '/upload') {
            t.is(hostname, 'woken.test');
            t.truthy(rotatedSecret);
            t.is(options.headers['x-workspace-secret'], rotatedSecret);
            return {
                ok: true,
                async json() {
                    return { bytesWritten: 6 };
                },
            };
        }

        throw new Error(`unexpected fetch: ${url}`);
    };

    try {
        const result = await workspaceClientModule.workspaceUploadFile(
            'entity-123',
            tempFile,
            '/tmp/workspace-restore.tar.gz',
        );

        t.deepEqual(result, { success: true, bytesWritten: 6 });
        t.deepEqual(startCalls, [{
            containerId: 'workspace-entity-123',
            containerName: 'workspace-entity-123',
        }]);
        t.true(fetchCalls.some(call => call.url === 'http://woken.test:3100/reconfigure'));
        t.true(fetchCalls.some(call => call.url === 'http://woken.test:3100/upload?path=%2Ftmp%2Fworkspace-restore.tar.gz'));
        t.false(fetchCalls.some(call => call.url === 'http://woken.test:3100/write'));
        t.false(fetchCalls.some(call => call.url === 'http://woken.test:3100/shell'));
        t.false(fetchCalls.some(call => call.url.startsWith('http://stopped.test:3100/upload')));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
        ACIBackend.prototype.start = originalStart;
        global.fetch = originalFetch;
        restoreEntityStore();
        restoreConfig();
    }
});

test.serial('hasRunningBackgroundJobs detects running workspace jobs', async (t) => {
    const originalFetch = global.fetch;

    global.fetch = async (url, options) => {
        t.is(url, 'http://workspace.test:3100/shell/jobs');
        t.is(options.headers['x-workspace-secret'], 'secret-123');
        return {
            ok: true,
            async json() {
                return {
                    jobs: [
                        { processId: 'done', status: 'completed' },
                        { processId: 'active', status: 'running' },
                    ],
                };
            },
        };
    };

    try {
        const result = await workspaceClientModule.__testables.hasRunningBackgroundJobs({
            workspace: {
                url: 'http://workspace.test:3100',
                secret: 'secret-123',
            },
        });

        t.true(result);
    } finally {
        global.fetch = originalFetch;
    }
});

test.serial('hasRunningBackgroundJobs accepts workspace /shell/jobs array response', async (t) => {
    const originalFetch = global.fetch;

    global.fetch = async (url, options) => {
        t.is(url, 'http://workspace.test:3100/shell/jobs');
        t.is(options.headers['x-workspace-secret'], 'secret-123');
        return {
            ok: true,
            status: 200,
            async json() {
                return [
                    { processId: 'done', status: 'completed' },
                    { processId: 'active', status: 'running' },
                ];
            },
        };
    };

    try {
        const details = await workspaceClientModule.__testables.getWorkspaceBackgroundJobsStatus({
            workspace: {
                url: 'http://workspace.test:3100',
                secret: 'secret-123',
            },
        });

        t.true(details.hasRunningJobs);
        t.true(details.ok);
        t.is(details.responseType, 'array');
        t.is(details.runningJobCount, 1);
        t.deepEqual(details.jobs.map(job => job.processId), ['done', 'active']);
    } finally {
        global.fetch = originalFetch;
    }
});

test.serial('getWorkspaceBackgroundJobsStatus recovers bootstrap auth before checking jobs', async (t) => {
    const originalFetch = global.fetch;
    const entityId = 'entity-background-jobs-auth-recovery';
    const calls = [];
    let freshSecret = null;
    const store = stubMutableEntityStore({
        id: entityId,
        workspace: {
            url: 'http://workspace.test:3100',
            secret: 'stale-secret',
            bootstrapSecret: 'bootstrap-secret',
            containerId: 'workspace-entity-background-jobs-auth-recovery',
            status: 'running',
        },
    });

    global.fetch = async (url, options = {}) => {
        const urlString = String(url);
        calls.push({
            url: urlString,
            secret: options.headers?.['x-workspace-secret'],
            hasDispatcher: Boolean(options.dispatcher),
        });
        if (urlString.endsWith('/shell/jobs') && options.headers?.['x-workspace-secret'] === 'stale-secret') {
            return {
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                async json() {
                    return { error: 'Invalid secret' };
                },
            };
        }
        if (urlString.endsWith('/reconfigure')) {
            t.is(options.headers?.['x-workspace-secret'], 'bootstrap-secret');
            const body = JSON.parse(options.body);
            t.truthy(body.secret);
            freshSecret = body.secret;
            return {
                ok: true,
                status: 200,
                async json() {
                    return { success: true };
                },
            };
        }
        if (urlString.endsWith('/shell/jobs')) {
            t.is(options.headers?.['x-workspace-secret'], freshSecret);
            return {
                ok: true,
                status: 200,
                async json() {
                    return [];
                },
            };
        }
        t.fail(`unexpected fetch url ${urlString}`);
    };

    try {
        const details = await workspaceClientModule.__testables.getWorkspaceBackgroundJobsStatus(store.getEntity());

        t.true(details.ok);
        t.false(details.hasRunningJobs);
        t.true(details.authRecovered);
        t.is(details.reason, 'no-running-jobs');
        t.is(details.runningJobCount, 0);
        t.truthy(freshSecret);
        t.deepEqual(calls.map(call => call.url), [
            'http://workspace.test:3100/shell/jobs',
            'http://workspace.test:3100/reconfigure',
            'http://workspace.test:3100/shell/jobs',
        ]);
        t.is(calls[0].secret, 'stale-secret');
        t.is(calls[1].secret, 'bootstrap-secret');
        t.is(calls[2].secret, freshSecret);
    } finally {
        global.fetch = originalFetch;
        workspaceClientModule.__testables.resetActivityStateForTest();
        store.restore();
    }
});

test.serial('getWorkspaceBackgroundJobsStatus refreshes ACI URL before bootstrap auth recovery', async (t) => {
    const restoreConfig = stubConfig({
        workspaceBackend: 'aci',
    });
    const originalFetch = global.fetch;
    const originalGetContainerUrl = ACIBackend.prototype.getContainerUrl;
    const entityId = 'entity-background-jobs-url-refresh';
    const calls = [];
    let freshSecret = null;
    const store = stubMutableEntityStore({
        id: entityId,
        workspace: {
            url: 'http://old-ip.test:3100',
            secret: 'stale-secret',
            bootstrapSecret: 'bootstrap-secret',
            containerId: 'workspace-entity-url-refresh',
            status: 'running',
        },
    });

    ACIBackend.prototype.getContainerUrl = async function (containerId) {
        calls.push({ type: 'getContainerUrl', containerId });
        return 'http://new-ip.test:3100';
    };

    global.fetch = async (url, options = {}) => {
        const urlString = String(url);
        calls.push({
            type: 'fetch',
            url: urlString,
            secret: options.headers?.['x-workspace-secret'],
        });

        if (urlString === 'http://old-ip.test:3100/shell/jobs') {
            t.is(options.headers?.['x-workspace-secret'], 'stale-secret');
            return {
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                async json() {
                    return { error: 'Invalid secret' };
                },
            };
        }

        if (urlString === 'http://new-ip.test:3100/shell/jobs' &&
            options.headers?.['x-workspace-secret'] === 'stale-secret') {
            return {
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                async json() {
                    return { error: 'Invalid secret' };
                },
            };
        }

        if (urlString === 'http://new-ip.test:3100/reconfigure') {
            t.is(options.headers?.['x-workspace-secret'], 'bootstrap-secret');
            const body = JSON.parse(options.body);
            t.truthy(body.secret);
            freshSecret = body.secret;
            return {
                ok: true,
                status: 200,
                async json() {
                    return { success: true };
                },
            };
        }

        if (urlString === 'http://new-ip.test:3100/shell/jobs' &&
            options.headers?.['x-workspace-secret'] === freshSecret) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return [];
                },
            };
        }

        t.fail(`unexpected fetch url ${urlString}`);
    };

    try {
        const details = await workspaceClientModule.__testables.getWorkspaceBackgroundJobsStatus(store.getEntity());

        t.true(details.ok);
        t.false(details.hasRunningJobs);
        t.true(details.authRecovered);
        t.is(store.getEntity().workspace.url, 'http://new-ip.test:3100');
        t.is(store.getEntity().workspace.secret, freshSecret);
        t.deepEqual(
            calls
                .filter(call => call.type === 'fetch')
                .map(call => `${call.url} ${call.secret}`),
            [
                'http://old-ip.test:3100/shell/jobs stale-secret',
                'http://new-ip.test:3100/shell/jobs stale-secret',
                'http://new-ip.test:3100/reconfigure bootstrap-secret',
                `http://new-ip.test:3100/shell/jobs ${freshSecret}`,
            ],
        );
        t.false(calls.some(call => call.url === 'http://old-ip.test:3100/reconfigure'));
    } finally {
        global.fetch = originalFetch;
        ACIBackend.prototype.getContainerUrl = originalGetContainerUrl;
        workspaceClientModule.__testables.resetActivityStateForTest();
        store.restore();
        restoreConfig();
    }
});

test.serial('hasRunningBackgroundJobs allows stop when only completed jobs remain', async (t) => {
    const originalFetch = global.fetch;

    global.fetch = async () => ({
        ok: true,
        async json() {
            return {
                jobs: [
                    { processId: 'done', status: 'completed' },
                    { processId: 'failed', status: 'failed' },
                ],
            };
        },
    });

    try {
        const result = await workspaceClientModule.__testables.hasRunningBackgroundJobs({
            workspace: {
                url: 'http://workspace.test:3100',
                secret: 'secret-123',
            },
        });

        t.false(result);
    } finally {
        global.fetch = originalFetch;
    }
});

test.serial('hasRunningBackgroundJobs fails closed when jobs check fails', async (t) => {
    const originalFetch = global.fetch;
    const logCapture = stubLogger();

    global.fetch = async () => ({
        ok: false,
        status: 500,
    });

    try {
        const result = await workspaceClientModule.__testables.hasRunningBackgroundJobs({
            workspace: {
                url: 'http://workspace.test:3100',
                secret: 'secret-123',
            },
        });

        t.true(result);
        t.true(logCapture.calls.some(call => call.level === 'warn'));
    } finally {
        logCapture.restore();
        global.fetch = originalFetch;
    }
});

test.serial('reapIdleWorkspaces honors newer Redis activity from another worker', async (t) => {
    const now = 10_000_000;
    const idleTimeoutMs = 30 * 60 * 1000;
    const entityId = 'entity-123';
    const redisLastActivity = now - 60_000;
    const localStaleActivity = now - idleTimeoutMs - 1;
    const fakeRedis = createFakeRedis({
        activityTimestamp: redisLastActivity,
        activityIndex: { [entityId]: localStaleActivity },
    });

    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: 'redis://test',
        workspaceBackend: 'aci',
        workspaceIdleTimeoutMs: idleTimeoutMs,
    });
    const restoreEntityStore = stubEntityStore({
        id: entityId,
        workspace: {
            url: 'http://workspace.test:3100',
            secret: 'secret-123',
            containerId: 'workspace-entity-123',
            shareName: 'workspace-entity-123',
            status: 'running',
        },
    });
    const originalFetch = global.fetch;
    const originalList = ACIBackend.prototype.listWorkspaceContainers;
    const originalStop = ACIBackend.prototype.stop;
    const originalNow = Date.now;
    let stopCalled = false;

    workspaceClientModule.__testables.resetActivityStateForTest();
    workspaceClientModule.__testables.setActivityRedisClientForTest(fakeRedis);
    workspaceClientModule.__testables.lastActivity.set(entityId, localStaleActivity);

    Date.now = () => now;
    global.fetch = async () => {
        t.fail('reaper should not check background jobs when Redis activity is still fresh');
    };
    ACIBackend.prototype.listWorkspaceContainers = undefined;
    ACIBackend.prototype.stop = async () => {
        stopCalled = true;
        return {};
    };

    try {
        await workspaceClientModule.__testables.reapIdleWorkspaces();

        t.false(stopCalled);
        t.is(workspaceClientModule.__testables.lastActivity.get(entityId), redisLastActivity);
        t.true(fakeRedis.calls.some(call => call.op === 'set' && call.key.endsWith(':reaper-lock:entity-123')));
        t.true(fakeRedis.calls.some(call => call.op === 'del' && call.key.endsWith(':reaper-lock:entity-123')));
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        Date.now = originalNow;
        ACIBackend.prototype.listWorkspaceContainers = originalList;
        ACIBackend.prototype.stop = originalStop;
        global.fetch = originalFetch;
        restoreEntityStore();
        restoreConfig();
    }
});

test.serial('reapIdleWorkspaces uses local activity when Redis is not configured', async (t) => {
    const now = 10_000_000;
    const idleTimeoutMs = 30 * 60 * 1000;
    const entityId = 'entity-local-reaper';
    const staleActivity = now - idleTimeoutMs - 1;

    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: '',
        workspaceBackend: 'aci',
        workspaceIdleTimeoutMs: idleTimeoutMs,
    });
    const restoreEntityStore = stubEntityStore({
        id: entityId,
        workspace: {
            url: 'http://workspace.test:3100',
            secret: 'secret-local',
            containerId: 'workspace-entity-local-reaper',
            shareName: 'workspace-entity-local-reaper',
            status: 'running',
        },
    });
    const originalFetch = global.fetch;
    const originalList = ACIBackend.prototype.listWorkspaceContainers;
    const originalRemove = ACIBackend.prototype.remove;
    const originalNow = Date.now;
    let removeCalled = false;

    workspaceClientModule.__testables.resetActivityStateForTest();
    workspaceClientModule.__testables.lastActivity.set(entityId, staleActivity);

    Date.now = () => now;
    ACIBackend.prototype.listWorkspaceContainers = undefined;
    global.fetch = async (url) => {
        const urlString = String(url);
        if (urlString.endsWith('/shell/jobs')) {
            return {
                ok: true,
                async json() {
                    return { jobs: [] };
                },
            };
        }
        if (urlString.endsWith('/health')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { version: '1.0.2' };
                },
            };
        }
        if (urlString.endsWith('/status')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { version: '1.0.2' };
                },
            };
        }
        t.fail(`unexpected fetch: ${urlString}`);
    };
    ACIBackend.prototype.remove = async (name) => {
        removeCalled = true;
        t.is(name, 'workspace-entity-local-reaper');
        return {};
    };

    try {
        await workspaceClientModule.__testables.reapIdleWorkspaces();

        t.true(removeCalled);
        t.false(workspaceClientModule.__testables.lastActivity.has(entityId));
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        Date.now = originalNow;
        ACIBackend.prototype.listWorkspaceContainers = originalList;
        ACIBackend.prototype.remove = originalRemove;
        global.fetch = originalFetch;
        restoreEntityStore();
        restoreConfig();
    }
});

test.serial('reapIdleWorkspaces checkpoints maintenance-idle ACI workspace before reap timeout', async (t) => {
    const now = 10_000_000;
    const idleTimeoutMs = 30 * 60 * 1000;
    const checkpointIdleMs = 5 * 60 * 1000;
    const entityId = 'entity-maintenance-checkpoint';
    const lastActivityAt = now - checkpointIdleMs - 1;
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: '',
        workspaceBackend: 'aci',
        workspaceIdleTimeoutMs: idleTimeoutMs,
        workspaceIdleCheckpointMs: checkpointIdleMs,
    });
    const store = stubMutableEntityStore({
        id: entityId,
        workspace: {
            url: 'http://workspace.test:3100',
            secret: 'secret-maintenance',
            containerId: 'workspace-entity-maintenance-checkpoint',
            status: 'running',
            imageVersion: '1.0.6',
        },
    });
    const originalFetch = global.fetch;
    const originalList = ACIBackend.prototype.listWorkspaceContainers;
    const originalRemove = ACIBackend.prototype.remove;
    const originalNow = Date.now;
    let removeCalled = false;
    let uploadCalled = false;

    workspaceClientModule.__testables.resetActivityStateForTest();
    workspaceClientModule.__testables.lastActivity.set(entityId, lastActivityAt);
    workspaceClientModule.__testables.setWorkspaceCheckpointUploadForTest(async () => {
        uploadCalled = true;
        return {
            blobPath: 'workspace-checkpoints/test-cortex/entity-maintenance-checkpoint/workspace.tar.gz',
            sizeBytes: 1024,
            sizeMB: 0.01,
            timestamp: new Date(now).toISOString(),
        };
    });

    Date.now = () => now;
    ACIBackend.prototype.listWorkspaceContainers = undefined;
    ACIBackend.prototype.remove = async () => {
        removeCalled = true;
    };
    global.fetch = async (url) => {
        const urlString = String(url);
        if (urlString.endsWith('/shell/jobs')) {
            return {
                ok: true,
                async json() {
                    return { jobs: [] };
                },
            };
        }
        if (urlString.endsWith('/health')) {
            return {
                ok: true,
                async json() {
                    return { version: '1.0.6' };
                },
            };
        }
        if (urlString.endsWith('/status')) {
            return {
                ok: true,
                async json() {
                    return { uptime: 123 };
                },
            };
        }
        if (urlString.endsWith('/backup')) {
            return {
                ok: true,
                async json() {
                    return {
                        path: '/persist/workspace.tar.gz',
                        sizeMB: 0.01,
                        timestamp: new Date(now).toISOString(),
                    };
                },
            };
        }
        t.fail(`unexpected fetch: ${urlString}`);
    };

    try {
        await workspaceClientModule.__testables.reapIdleWorkspaces();

        t.true(uploadCalled);
        t.false(removeCalled);
        t.is(
            store.getEntity().workspace.checkpointBlobPath,
            'workspace-checkpoints/test-cortex/entity-maintenance-checkpoint/workspace.tar.gz',
        );
        t.true(workspaceClientModule.__testables.lastActivity.has(entityId));
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        Date.now = originalNow;
        ACIBackend.prototype.listWorkspaceContainers = originalList;
        ACIBackend.prototype.remove = originalRemove;
        global.fetch = originalFetch;
        store.restore();
        restoreConfig();
    }
});

test.serial('reapIdleWorkspaces checkpoints maintenance-idle ACI inventory workspace before reap timeout', async (t) => {
    const now = 10_000_000;
    const idleTimeoutMs = 30 * 60 * 1000;
    const checkpointIdleMs = 5 * 60 * 1000;
    const entityId = 'entity-inventory-checkpoint';
    const containerName = 'workspace-entity-inventory-checkpoint';
    const lastActivityAt = now - checkpointIdleMs - 1;
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: '',
        workspaceBackend: 'aci',
        workspaceIdleTimeoutMs: idleTimeoutMs,
        workspaceIdleCheckpointMs: checkpointIdleMs,
        workspaceContainerPrefix: 'workspace',
    });
    const store = stubMutableEntityStore({
        id: entityId,
        workspace: {
            url: 'http://workspace.test:3100',
            secret: 'secret-inventory',
            containerId: containerName,
            status: 'running',
            imageVersion: '1.0.6',
        },
    });
    const originalFetch = global.fetch;
    const originalList = ACIBackend.prototype.listWorkspaceContainers;
    const originalRemove = ACIBackend.prototype.remove;
    const originalNow = Date.now;
    let removeCalled = false;
    let uploadCalled = false;

    workspaceClientModule.__testables.resetActivityStateForTest();
    workspaceClientModule.__testables.lastActivity.set(entityId, lastActivityAt);
    workspaceClientModule.__testables.setWorkspaceCheckpointUploadForTest(async () => {
        uploadCalled = true;
        return {
            blobPath: 'workspace-checkpoints/test-cortex/entity-inventory-checkpoint/workspace.tar.gz',
            sizeBytes: 2048,
            sizeMB: 0.02,
            timestamp: new Date(now).toISOString(),
        };
    });

    Date.now = () => now;
    ACIBackend.prototype.listWorkspaceContainers = async () => [{
        name: containerName,
        createdAt: new Date(now - 10 * 60 * 1000).toISOString(),
        tags: {
            managedBy: 'cortex',
            workspaceContainerPrefix: 'workspace',
            entityId,
        },
    }];
    ACIBackend.prototype.remove = async () => {
        removeCalled = true;
    };
    global.fetch = async (url) => {
        const urlString = String(url);
        if (urlString.endsWith('/shell/jobs')) {
            return {
                ok: true,
                async json() {
                    return { jobs: [] };
                },
            };
        }
        if (urlString.endsWith('/health')) {
            return {
                ok: true,
                async json() {
                    return { version: '1.0.6' };
                },
            };
        }
        if (urlString.endsWith('/status')) {
            return {
                ok: true,
                async json() {
                    return { uptime: 123 };
                },
            };
        }
        if (urlString.endsWith('/backup')) {
            return {
                ok: true,
                async json() {
                    return {
                        path: '/persist/workspace.tar.gz',
                        sizeMB: 0.02,
                        timestamp: new Date(now).toISOString(),
                    };
                },
            };
        }
        t.fail(`unexpected fetch: ${urlString}`);
    };

    try {
        await workspaceClientModule.__testables.reapIdleWorkspaces();

        t.true(uploadCalled);
        t.false(removeCalled);
        t.is(
            store.getEntity().workspace.checkpointBlobPath,
            'workspace-checkpoints/test-cortex/entity-inventory-checkpoint/workspace.tar.gz',
        );
        t.true(workspaceClientModule.__testables.lastActivity.has(entityId));
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        Date.now = originalNow;
        ACIBackend.prototype.listWorkspaceContainers = originalList;
        ACIBackend.prototype.remove = originalRemove;
        global.fetch = originalFetch;
        store.restore();
        restoreConfig();
    }
});

test.serial('reapIdleWorkspaces reaps ACI workspace without backup when checkpoint is fresh', async (t) => {
    const now = 10_000_000;
    const idleTimeoutMs = 30 * 60 * 1000;
    const entityId = 'entity-fresh-checkpoint-reap';
    const lastActivityAt = now - idleTimeoutMs - 1;
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: '',
        workspaceBackend: 'aci',
        workspaceIdleTimeoutMs: idleTimeoutMs,
        workspaceIdleCheckpointMs: 5 * 60 * 1000,
    });
    const store = stubMutableEntityStore({
        id: entityId,
        workspace: {
            url: 'http://workspace.test:3100',
            secret: 'secret-fresh-checkpoint',
            containerId: 'workspace-entity-fresh-checkpoint-reap',
            status: 'running',
            checkpointBlobPath: 'workspace-checkpoints/test-cortex/entity-fresh-checkpoint-reap/workspace.tar.gz',
            checkpointedAt: new Date(now - 60_000).toISOString(),
        },
    });
    const originalFetch = global.fetch;
    const originalList = ACIBackend.prototype.listWorkspaceContainers;
    const originalRemove = ACIBackend.prototype.remove;
    const originalNow = Date.now;
    let removeCalled = false;

    workspaceClientModule.__testables.resetActivityStateForTest();
    workspaceClientModule.__testables.lastActivity.set(entityId, lastActivityAt);

    Date.now = () => now;
    ACIBackend.prototype.listWorkspaceContainers = undefined;
    ACIBackend.prototype.remove = async (name) => {
        removeCalled = true;
        t.is(name, 'workspace-entity-fresh-checkpoint-reap');
    };
    global.fetch = async (url) => {
        const urlString = String(url);
        if (urlString.endsWith('/shell/jobs')) {
            return {
                ok: true,
                async json() {
                    return { jobs: [] };
                },
            };
        }
        t.fail(`unexpected fetch: ${urlString}`);
    };

    try {
        await workspaceClientModule.__testables.reapIdleWorkspaces();

        t.true(removeCalled);
        t.false(workspaceClientModule.__testables.lastActivity.has(entityId));
        t.is(
            store.getEntity().workspace.checkpointBlobPath,
            'workspace-checkpoints/test-cortex/entity-fresh-checkpoint-reap/workspace.tar.gz',
        );
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        Date.now = originalNow;
        ACIBackend.prototype.listWorkspaceContainers = originalList;
        ACIBackend.prototype.remove = originalRemove;
        global.fetch = originalFetch;
        store.restore();
        restoreConfig();
    }
});

test.serial('destroyWorkspace destroyVolume deletes checkpoint blobs before clearing workspace', async (t) => {
    const entityId = 'entity-destroy-checkpoint';
    const containerName = 'workspace-entity-destroy-checkpoint';
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: '',
        workspaceBackend: 'aci',
        workspaceIdleTimeoutMs: 30 * 60 * 1000,
        workspaceAzureFilesStorageAccountName: '',
        workspaceAzureFilesStorageAccountKey: '',
    });
    const checkpointBlobPath = workspaceClientModule.__testables.workspaceCheckpointBlobPath(entityId);
    const checkpointPreviousBlobPath = workspaceClientModule.__testables.workspaceCheckpointBlobPath(entityId, 'workspace.prev.tar.gz');
    const store = stubMutableEntityStore({
        id: entityId,
        workspace: {
            containerId: containerName,
            status: 'running',
            url: 'http://workspace.test:3100',
            secret: 'workspace-secret',
            checkpointBlobPath,
            checkpointPreviousBlobPath,
            checkpointedAt: new Date().toISOString(),
        },
    });
    const originalRemove = ACIBackend.prototype.remove;
    const originalDestroyVolume = ACIBackend.prototype.destroyVolume;
    const removedContainers = [];
    const destroyedVolumes = [];
    const deletedBlobs = [];

    ACIBackend.prototype.remove = async function (containerId, requestedName) {
        removedContainers.push({ containerId, requestedName });
    };
    ACIBackend.prototype.destroyVolume = async function (shareName) {
        destroyedVolumes.push(shareName);
    };
    workspaceClientModule.__testables.setWorkspaceCheckpointContainerClientForTest({
        getBlockBlobClient(blobPath) {
            return {
                async deleteIfExists() {
                    deletedBlobs.push(blobPath);
                    return { succeeded: true };
                },
            };
        },
    });

    try {
        const result = await workspaceClientModule.destroyWorkspace(entityId, store.getEntity(), {
            destroyVolume: true,
        });

        t.true(result.success);
        t.deepEqual(removedContainers, [{ containerId: containerName, requestedName: containerName }]);
        t.deepEqual(destroyedVolumes, []);
        t.deepEqual(deletedBlobs.sort(), [checkpointPreviousBlobPath, checkpointBlobPath].sort());
        t.is(store.getEntity().workspace, null);
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        ACIBackend.prototype.remove = originalRemove;
        ACIBackend.prototype.destroyVolume = originalDestroyVolume;
        store.restore();
        restoreConfig();
    }
});

test.serial('destroyWorkspace loads existing entity config when caller passes only id', async (t) => {
    const entityId = 'entity-destroy-id-only';
    const containerName = 'workspace-entity-destroy-id-only';
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: '',
        workspaceBackend: 'aci',
        workspaceIdleTimeoutMs: 30 * 60 * 1000,
    });
    const store = stubMutableEntityStore({
        id: entityId,
        name: 'Entity Destroy Id Only',
        workspace: {
            containerId: containerName,
            status: 'running',
            url: 'http://workspace.test:3100',
            secret: 'workspace-secret',
        },
    });
    const originalRemove = ACIBackend.prototype.remove;
    const removedContainers = [];

    ACIBackend.prototype.remove = async function (containerId, requestedName) {
        removedContainers.push({ containerId, requestedName });
    };

    try {
        const result = await workspaceClientModule.destroyWorkspace(entityId, undefined, {
            skipCheckpoint: true,
        });

        t.true(result.success);
        t.deepEqual(removedContainers, [{ containerId: containerName, requestedName: containerName }]);
        t.is(store.getEntity().id, entityId);
        t.is(store.getEntity().name, 'Entity Destroy Id Only');
        t.deepEqual(store.getEntity().workspace, {});
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        ACIBackend.prototype.remove = originalRemove;
        store.restore();
        restoreConfig();
    }
});

test.serial('destroyWorkspace applies caller timeout to pre-destroy checkpoint', async (t) => {
    const entityId = 'entity-checkpoint-timeout';
    const containerName = 'workspace-entity-checkpoint-timeout';
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: '',
        workspaceBackend: 'aci',
        workspaceIdleTimeoutMs: 30 * 60 * 1000,
    });
    const store = stubMutableEntityStore({
        id: entityId,
        workspace: {
            containerId: containerName,
            status: 'running',
            url: 'http://workspace.test:3100',
            secret: 'workspace-secret',
        },
    });
    const originalFetch = global.fetch;
    const originalRemove = ACIBackend.prototype.remove;
    let removeCalled = false;

    ACIBackend.prototype.remove = async () => {
        removeCalled = true;
    };
    global.fetch = async (_url, options = {}) => new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => {
            reject(new Error('aborted by test signal'));
        });
    });

    try {
        const startedAt = Date.now();
        const result = await workspaceClientModule.destroyWorkspace(entityId, store.getEntity(), {
            timeoutMs: 20,
        });

        t.false(result.success);
        t.regex(result.error, /Checkpoint failed: \/health fetch failed: aborted by test signal/);
        t.true(Date.now() - startedAt < 1000);
        t.false(removeCalled);
    } finally {
        global.fetch = originalFetch;
        ACIBackend.prototype.remove = originalRemove;
        store.restore();
        restoreConfig();
    }
});

test.serial('destroyWorkspace skips checkpoint when stored checkpoint is fresh against tracked activity', async (t) => {
    const entityId = 'entity-fresh-manual-destroy';
    const containerName = 'workspace-entity-fresh-manual-destroy';
    const now = Date.now();
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: '',
        workspaceBackend: 'aci',
        workspaceIdleTimeoutMs: 30 * 60 * 1000,
        workspaceAzureFilesStorageAccountName: '',
        workspaceAzureFilesStorageAccountKey: '',
    });
    const store = stubMutableEntityStore({
        id: entityId,
        workspace: {
            containerId: containerName,
            status: 'running',
            url: 'http://workspace.test:3100',
            secret: 'workspace-secret',
            checkpointBlobPath: 'workspace-checkpoints/test-cortex/entity-fresh-manual-destroy/workspace.tar.gz',
            checkpointedAt: new Date(now).toISOString(),
        },
    });
    const originalFetch = global.fetch;
    const originalRemove = ACIBackend.prototype.remove;
    const removedContainers = [];

    workspaceClientModule.__testables.resetActivityStateForTest();
    workspaceClientModule.__testables.lastActivity.set(entityId, now - 1000);
    ACIBackend.prototype.remove = async function (containerId, requestedName) {
        removedContainers.push({ containerId, requestedName });
    };
    global.fetch = async (url) => {
        t.fail(`unexpected checkpoint fetch: ${url}`);
    };

    try {
        const result = await workspaceClientModule.destroyWorkspace(entityId, store.getEntity());

        t.true(result.success);
        t.deepEqual(removedContainers, [{ containerId: containerName, requestedName: containerName }]);
        t.is(
            store.getEntity().workspace.checkpointBlobPath,
            'workspace-checkpoints/test-cortex/entity-fresh-manual-destroy/workspace.tar.gz',
        );
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        ACIBackend.prototype.remove = originalRemove;
        global.fetch = originalFetch;
        store.restore();
        restoreConfig();
    }
});

test.serial('destroyWorkspace recovers fresh checkpoint metadata from Blob before checkpointing', async (t) => {
    const entityId = 'entity-fresh-blob-manual-destroy';
    const containerName = 'workspace-entity-fresh-blob-manual-destroy';
    const lastActivityAt = Date.parse('2026-05-24T02:38:19.000Z');
    const blobCheckpointedAt = '2026-05-24T02:44:03.690Z';
    const checkpointBlobPath = 'workspace-checkpoints/test-cortex/entity-fresh-blob-manual-destroy/workspace.tar.gz';
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: '',
        workspaceBackend: 'aci',
        workspaceIdleTimeoutMs: 30 * 60 * 1000,
        workspaceAzureFilesStorageAccountName: '',
        workspaceAzureFilesStorageAccountKey: '',
    });
    const store = stubMutableEntityStore({
        id: entityId,
        workspace: {
            containerId: containerName,
            status: 'running',
            url: 'http://workspace.test:3100',
            secret: 'workspace-secret',
            checkpointBlobPath,
            checkpointSizeBytes: 123,
            checkpointSizeMB: 0.01,
            checkpointedAt: '2026-05-24T02:33:22.803Z',
        },
    });
    const originalFetch = global.fetch;
    const originalRemove = ACIBackend.prototype.remove;
    const removedContainers = [];

    workspaceClientModule.__testables.resetActivityStateForTest();
    workspaceClientModule.__testables.lastActivity.set(entityId, lastActivityAt);
    workspaceClientModule.__testables.setWorkspaceCheckpointContainerClientForTest({
        getBlockBlobClient(blobPath) {
            t.is(blobPath, checkpointBlobPath);
            return {
                async getProperties() {
                    return {
                        contentLength: 334673497,
                        lastModified: new Date(blobCheckpointedAt),
                        metadata: workspaceClientModule.__testables.workspaceCheckpointBlobMetadata(entityId, {
                            checkpointedAt: blobCheckpointedAt,
                        }),
                    };
                },
            };
        },
    });
    ACIBackend.prototype.remove = async function (containerId, requestedName) {
        removedContainers.push({ containerId, requestedName });
    };
    global.fetch = async (url) => {
        t.fail(`unexpected checkpoint fetch: ${url}`);
    };

    try {
        const result = await workspaceClientModule.destroyWorkspace(entityId, store.getEntity());

        t.true(result.success);
        t.deepEqual(removedContainers, [{ containerId: containerName, requestedName: containerName }]);
        t.is(store.getEntity().workspace.checkpointBlobPath, checkpointBlobPath);
        t.is(store.getEntity().workspace.checkpointSizeBytes, 334673497);
        t.is(store.getEntity().workspace.checkpointSizeMB, 319.17);
        t.is(store.getEntity().workspace.checkpointedAt, blobCheckpointedAt);
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        ACIBackend.prototype.remove = originalRemove;
        global.fetch = originalFetch;
        store.restore();
        restoreConfig();
    }
});

test.serial('destroyWorkspace trusts valid checkpoint Blob when no activity is tracked', async (t) => {
    const entityId = 'entity-no-activity-blob-manual-destroy';
    const containerName = 'workspace-entity-no-activity-blob-manual-destroy';
    const blobCheckpointedAt = '2026-05-24T02:44:03.690Z';
    const checkpointBlobPath = 'workspace-checkpoints/test-cortex/entity-no-activity-blob-manual-destroy/workspace.tar.gz';
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: '',
        workspaceBackend: 'aci',
        workspaceIdleTimeoutMs: 30 * 60 * 1000,
        workspaceAzureFilesStorageAccountName: '',
        workspaceAzureFilesStorageAccountKey: '',
    });
    const store = stubMutableEntityStore({
        id: entityId,
        workspace: {
            containerId: containerName,
            status: 'running',
            url: 'http://workspace.test:3100',
            secret: 'workspace-secret',
            checkpointBlobPath,
            checkpointedAt: '2026-05-24T02:33:22.803Z',
        },
    });
    const originalFetch = global.fetch;
    const originalRemove = ACIBackend.prototype.remove;
    const removedContainers = [];

    workspaceClientModule.__testables.resetActivityStateForTest();
    workspaceClientModule.__testables.setWorkspaceCheckpointContainerClientForTest({
        getBlockBlobClient(blobPath) {
            t.is(blobPath, checkpointBlobPath);
            return {
                async getProperties() {
                    return {
                        contentLength: 334673497,
                        lastModified: new Date(blobCheckpointedAt),
                        metadata: workspaceClientModule.__testables.workspaceCheckpointBlobMetadata(entityId, {
                            checkpointedAt: blobCheckpointedAt,
                        }),
                    };
                },
            };
        },
    });
    ACIBackend.prototype.remove = async function (containerId, requestedName) {
        removedContainers.push({ containerId, requestedName });
    };
    global.fetch = async (url) => {
        t.fail(`unexpected checkpoint fetch: ${url}`);
    };

    try {
        const result = await workspaceClientModule.destroyWorkspace(entityId, store.getEntity());

        t.true(result.success);
        t.deepEqual(removedContainers, [{ containerId: containerName, requestedName: containerName }]);
        t.is(store.getEntity().workspace.checkpointBlobPath, checkpointBlobPath);
        t.is(store.getEntity().workspace.checkpointedAt, blobCheckpointedAt);
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        ACIBackend.prototype.remove = originalRemove;
        global.fetch = originalFetch;
        store.restore();
        restoreConfig();
    }
});

test.serial('destroyWorkspace accepts checkpoint timestamps from 1.0.9 workspace helpers', async (t) => {
    const entityId = 'entity-sanitized-checkpoint-timestamp';
    const containerName = 'workspace-entity-sanitized-checkpoint-timestamp';
    const lastActivityAt = Date.parse('2026-05-24T02:42:26.000Z');
    const checkpointTimestamp = '2026-05-24T02-44-03-690Z';
    const checkpointBlobPath = 'workspace-checkpoints/test-cortex/entity-sanitized-checkpoint-timestamp/workspace.tar.gz';
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: '',
        workspaceBackend: 'aci',
        workspaceIdleTimeoutMs: 30 * 60 * 1000,
        workspaceAzureFilesStorageAccountName: '',
        workspaceAzureFilesStorageAccountKey: '',
    });
    const store = stubMutableEntityStore({
        id: entityId,
        workspace: {
            containerId: containerName,
            status: 'running',
            url: 'http://workspace.test:3100',
            secret: 'workspace-secret',
            checkpointBlobPath,
            checkpointedAt: '2026-05-24T02:33:22.803Z',
        },
    });
    const originalFetch = global.fetch;
    const originalRemove = ACIBackend.prototype.remove;
    const removedContainers = [];

    workspaceClientModule.__testables.resetActivityStateForTest();
    workspaceClientModule.__testables.lastActivity.set(entityId, lastActivityAt);
    workspaceClientModule.__testables.setWorkspaceCheckpointUploadForTest(async (_entityId, _workspace, backupBody) => ({
        blobPath: checkpointBlobPath,
        sizeBytes: 334673497,
        sizeMB: 319.18,
        timestamp: backupBody.timestamp,
    }));
    ACIBackend.prototype.remove = async function (containerId, requestedName) {
        removedContainers.push({ containerId, requestedName });
    };
    global.fetch = async (url) => {
        const urlString = String(url);
        if (urlString.endsWith('/health')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { version: '1.0.9' };
                },
            };
        }
        if (urlString.endsWith('/status')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { version: '1.0.9' };
                },
            };
        }
        if (urlString.endsWith('/backup')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return {
                        path: '/persist/workspace.tar.gz',
                        sizeBytes: 334673497,
                        sizeMB: 319.18,
                        timestamp: checkpointTimestamp,
                    };
                },
            };
        }
        t.fail(`unexpected checkpoint fetch: ${urlString}`);
    };

    try {
        const result = await workspaceClientModule.destroyWorkspace(entityId, store.getEntity());

        t.true(result.success);
        t.deepEqual(removedContainers, [{ containerId: containerName, requestedName: containerName }]);
        t.is(store.getEntity().workspace.checkpointedAt, '2026-05-24T02:44:03.690Z');
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        ACIBackend.prototype.remove = originalRemove;
        global.fetch = originalFetch;
        store.restore();
        restoreConfig();
    }
});

test.serial('destroyWorkspace preserves existing checkpoint metadata without a fresh checkpoint', async (t) => {
    const entityId = 'entity-preserve-existing-checkpoint';
    const containerName = 'workspace-entity-preserve-existing-checkpoint';
    const checkpointBlobPath = 'workspace-checkpoints/test-cortex/entity-preserve-existing-checkpoint/workspace.tar.gz';
    const checkpointPreviousBlobPath = 'workspace-checkpoints/test-cortex/entity-preserve-existing-checkpoint/workspace.prev.tar.gz';
    const checkpointedAt = new Date().toISOString();
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: '',
        workspaceBackend: 'aci',
        workspaceIdleTimeoutMs: 30 * 60 * 1000,
    });
    const store = stubMutableEntityStore({
        id: entityId,
        workspace: {
            containerId: containerName,
            status: 'provisioning',
            shareName: 'legacy-share',
            checkpointBlobPath,
            checkpointPreviousBlobPath,
            checkpointSizeBytes: 1234,
            checkpointSizeMB: 0.01,
            checkpointedAt,
        },
    });
    const originalRemove = ACIBackend.prototype.remove;
    const removedContainers = [];

    ACIBackend.prototype.remove = async function (containerId, requestedName) {
        removedContainers.push({ containerId, requestedName });
    };

    try {
        const result = await workspaceClientModule.destroyWorkspace(entityId, store.getEntity());

        t.true(result.success);
        t.deepEqual(removedContainers, [{ containerId: containerName, requestedName: containerName }]);
        t.deepEqual(store.getEntity().workspace, {
            checkpointBlobPath,
            checkpointPreviousBlobPath,
            checkpointSizeBytes: 1234,
            checkpointSizeMB: 0.01,
            checkpointedAt,
            legacyShareName: 'legacy-share',
        });
    } finally {
        ACIBackend.prototype.remove = originalRemove;
        store.restore();
        restoreConfig();
    }
});

test.serial('destroyWorkspace preserves checkpoint encryption key returned on checkpoint entity config', async (t) => {
    const entityId = 'entity-destroy-encrypted-checkpoint';
    const containerName = 'workspace-entity-destroy-encrypted-checkpoint';
    const checkpointBlobPath = 'workspace-checkpoints/test-cortex/entity-destroy-encrypted-checkpoint/workspace.tar.gz';
    const checkpointEncryptionKey = {
        algorithm: 'aes-256-gcm',
        keyId: 'checkpoint-key-id',
        encryptedKey: 'encrypted-checkpoint-key',
        createdAt: '2026-05-24T17:51:40.000Z',
    };
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: '',
        workspaceBackend: 'aci',
        workspaceIdleTimeoutMs: 30 * 60 * 1000,
    });
    const store = stubMutableEntityStore({
        id: entityId,
        workspace: {
            containerId: containerName,
            status: 'running',
            url: 'http://workspace.test:3100',
            secret: 'workspace-secret',
        },
    });
    const originalFetch = global.fetch;
    const originalRemove = ACIBackend.prototype.remove;
    const removedContainers = [];

    workspaceClientModule.__testables.setWorkspaceCheckpointUploadForTest(async (_entityId, _workspace, backupBody) => ({
        blobPath: checkpointBlobPath,
        sizeBytes: 1234,
        timestamp: backupBody.timestamp,
        encryption: {
            algorithm: 'aes-256-gcm',
            keyId: checkpointEncryptionKey.keyId,
            ivBase64: Buffer.alloc(12, 5).toString('base64'),
            tagBase64: Buffer.alloc(16, 6).toString('base64'),
            compression: 'gzip',
        },
        entityConfig: {
            ...store.getEntity(),
            workspace: {
                ...store.getEntity().workspace,
                checkpointEncryptionKey,
            },
        },
    }));
    ACIBackend.prototype.remove = async function (containerId, requestedName) {
        removedContainers.push({ containerId, requestedName });
    };
    global.fetch = async (url) => {
        const urlString = String(url);
        if (urlString.endsWith('/health')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { version: '1.0.9' };
                },
            };
        }
        if (urlString.endsWith('/status')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { version: '1.0.9' };
                },
            };
        }
        if (urlString.endsWith('/backup')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return {
                        path: '/persist/workspace.tar.gz',
                        sizeBytes: 1234,
                        timestamp: '2026-05-24T17:51:40.000Z',
                    };
                },
            };
        }
        t.fail(`unexpected checkpoint fetch: ${urlString}`);
    };

    try {
        const result = await workspaceClientModule.destroyWorkspace(entityId, store.getEntity());

        t.true(result.success);
        t.deepEqual(removedContainers, [{ containerId: containerName, requestedName: containerName }]);
        t.deepEqual(store.getEntity().workspace.checkpointEncryptionKey, checkpointEncryptionKey);
        t.is(store.getEntity().workspace.checkpointEncryption.keyId, checkpointEncryptionKey.keyId);
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        ACIBackend.prototype.remove = originalRemove;
        global.fetch = originalFetch;
        store.restore();
        restoreConfig();
    }
});

test.serial('reapIdleWorkspaces skips stop when live workspace reports running background jobs', async (t) => {
    const now = 10_000_000;
    const idleTimeoutMs = 30 * 60 * 1000;
    const entityId = 'entity-456';
    const staleActivity = now - idleTimeoutMs - 1;
    const fakeRedis = createFakeRedis({
        activityTimestamp: staleActivity,
        activityIndex: { [entityId]: staleActivity },
    });

    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: 'redis://test',
        workspaceBackend: 'aci',
        workspaceIdleTimeoutMs: idleTimeoutMs,
    });
    const restoreEntityStore = stubEntityStore({
        id: entityId,
        workspace: {
            url: 'http://workspace.test:3100',
            secret: 'secret-456',
            containerId: 'workspace-entity-456',
            shareName: 'workspace-entity-456',
            status: 'running',
        },
    });
    const originalFetch = global.fetch;
    const originalList = ACIBackend.prototype.listWorkspaceContainers;
    const originalStop = ACIBackend.prototype.stop;
    const originalNow = Date.now;
    const logCapture = stubLogger();
    let stopCalled = false;
    let jobsChecked = false;

    workspaceClientModule.__testables.resetActivityStateForTest();
    workspaceClientModule.__testables.setActivityRedisClientForTest(fakeRedis);
    workspaceClientModule.__testables.lastActivity.set(entityId, staleActivity);

    Date.now = () => now;
    ACIBackend.prototype.listWorkspaceContainers = undefined;
    global.fetch = async (url, options) => {
        jobsChecked = true;
        t.is(url, 'http://workspace.test:3100/shell/jobs');
        t.is(options.headers['x-workspace-secret'], 'secret-456');
        return {
            ok: true,
            async json() {
                return {
                    jobs: [{
                        processId: 'bg-1',
                        status: 'running',
                        command: 'curl -H "Authorization: Bearer secret-token" https://example.test',
                    }],
                };
            },
        };
    };
    ACIBackend.prototype.stop = async () => {
        stopCalled = true;
        return {};
    };

    try {
        await workspaceClientModule.__testables.reapIdleWorkspaces();

        t.true(jobsChecked);
        t.false(stopCalled);
        t.is(workspaceClientModule.__testables.lastActivity.get(entityId), staleActivity);
        const reaperLog = logCapture.calls
            .map(call => call.message)
            .find(message => message.startsWith('[WorkspaceReaper]'));
        t.truthy(reaperLog);

        const decision = JSON.parse(reaperLog.slice('[WorkspaceReaper] '.length));
        t.is(decision.entityId, entityId);
        t.is(decision.action, 'skip');
        t.is(decision.reason, 'running-background-jobs');
        t.is(decision.localLastActivity, staleActivity);
        t.is(decision.redisLastActivity, staleActivity);
        t.is(decision.effectiveLastActivity, staleActivity);
        t.is(decision.workspace.containerId, 'workspace-entity-456');
        t.true(decision.workspace.hasSecret);
        t.true(decision.jobsCheck.attempted);
        t.true(decision.jobsCheck.hasRunningJobs);
        t.is(decision.jobsCheck.responseType, 'object');
        t.is(decision.jobsCheck.jobsContainer, 'jobs-property');
        t.is(decision.jobsCheck.jobCount, 1);
        t.is(decision.jobsCheck.runningJobCount, 1);
        t.deepEqual(decision.jobsCheck.jobStatusCounts, { running: 1 });
        t.false(Object.hasOwn(decision.jobsCheck, 'jobs'));
        t.false(reaperLog.includes('secret-token'));
        t.false(reaperLog.includes('Authorization'));
    } finally {
        logCapture.restore();
        workspaceClientModule.__testables.resetActivityStateForTest();
        Date.now = originalNow;
        ACIBackend.prototype.listWorkspaceContainers = originalList;
        ACIBackend.prototype.stop = originalStop;
        global.fetch = originalFetch;
        restoreEntityStore();
        restoreConfig();
    }
});

test.serial('reapIdleWorkspaces rechecks Redis activity after jobs check before stopping', async (t) => {
    const now = 10_000_000;
    const idleTimeoutMs = 30 * 60 * 1000;
    const entityId = 'entity-654';
    const staleActivity = now - idleTimeoutMs - 1;
    const freshActivity = now - 1_000;
    let redisActivity = staleActivity;
    const fakeRedis = createFakeRedis({
        activityTimestamp: () => redisActivity,
        activityIndex: { [entityId]: staleActivity },
    });

    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: 'redis://test',
        workspaceBackend: 'aci',
        workspaceIdleTimeoutMs: idleTimeoutMs,
    });
    const restoreEntityStore = stubEntityStore({
        id: entityId,
        workspace: {
            url: 'http://workspace.test:3100',
            secret: 'secret-654',
            containerId: 'workspace-entity-654',
            shareName: 'workspace-entity-654',
            status: 'running',
        },
    });
    const originalFetch = global.fetch;
    const originalList = ACIBackend.prototype.listWorkspaceContainers;
    const originalStop = ACIBackend.prototype.stop;
    const originalNow = Date.now;
    let stopCalled = false;

    workspaceClientModule.__testables.resetActivityStateForTest();
    workspaceClientModule.__testables.setActivityRedisClientForTest(fakeRedis);
    workspaceClientModule.__testables.lastActivity.set(entityId, staleActivity);

    Date.now = () => now;
    ACIBackend.prototype.listWorkspaceContainers = undefined;
    global.fetch = async () => {
        redisActivity = freshActivity;
        return {
            ok: true,
            async json() {
                return { jobs: [] };
            },
        };
    };
    ACIBackend.prototype.stop = async () => {
        stopCalled = true;
        return {};
    };

    try {
        await workspaceClientModule.__testables.reapIdleWorkspaces();

        t.false(stopCalled);
        t.is(workspaceClientModule.__testables.lastActivity.get(entityId), freshActivity);
        t.true(fakeRedis.calls.filter(call => call.op === 'get' && call.key.endsWith(':activity:entity-654')).length >= 2);
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        Date.now = originalNow;
        ACIBackend.prototype.listWorkspaceContainers = originalList;
        ACIBackend.prototype.stop = originalStop;
        global.fetch = originalFetch;
        restoreEntityStore();
        restoreConfig();
    }
});

test.serial('reapIdleWorkspaces skips stop when another host holds the Redis reaper lock', async (t) => {
    const now = 10_000_000;
    const idleTimeoutMs = 30 * 60 * 1000;
    const entityId = 'entity-789';
    const staleActivity = now - idleTimeoutMs - 1;
    const fakeRedis = createFakeRedis({
        activityTimestamp: staleActivity,
        activityIndex: { [entityId]: staleActivity },
        acquireLock: false,
    });

    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: 'redis://test',
        workspaceBackend: 'aci',
        workspaceIdleTimeoutMs: idleTimeoutMs,
    });
    const restoreEntityStore = stubEntityStore({
        id: entityId,
        workspace: {
            url: 'http://workspace.test:3100',
            secret: 'secret-789',
            containerId: 'workspace-entity-789',
            shareName: 'workspace-entity-789',
            status: 'running',
        },
    });
    const originalFetch = global.fetch;
    const originalList = ACIBackend.prototype.listWorkspaceContainers;
    const originalStop = ACIBackend.prototype.stop;
    const originalNow = Date.now;
    let stopCalled = false;

    workspaceClientModule.__testables.resetActivityStateForTest();
    workspaceClientModule.__testables.setActivityRedisClientForTest(fakeRedis);
    workspaceClientModule.__testables.lastActivity.set(entityId, staleActivity);

    Date.now = () => now;
    ACIBackend.prototype.listWorkspaceContainers = undefined;
    global.fetch = async () => {
        t.fail('reaper should not check background jobs without the Redis lock');
    };
    ACIBackend.prototype.stop = async () => {
        stopCalled = true;
        return {};
    };

    try {
        await workspaceClientModule.__testables.reapIdleWorkspaces();

        t.false(stopCalled);
        t.true(fakeRedis.calls.some(call => call.op === 'set' && call.key.endsWith(':reaper-lock:entity-789')));
        t.false(fakeRedis.calls.some(call => call.op === 'get' && call.key.endsWith(':activity:entity-789')));
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        Date.now = originalNow;
        ACIBackend.prototype.listWorkspaceContainers = originalList;
        ACIBackend.prototype.stop = originalStop;
        global.fetch = originalFetch;
        restoreEntityStore();
        restoreConfig();
    }
});

test.serial('reapIdleWorkspaces uses Redis activity index after local restart', async (t) => {
    const now = 10_000_000;
    const idleTimeoutMs = 30 * 60 * 1000;
    const entityId = 'entity-restarted';
    const staleActivity = now - idleTimeoutMs - 1;
    const fakeRedis = createFakeRedis({
        activityTimestamp: staleActivity,
        activityIndex: { [entityId]: staleActivity },
    });

    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: 'redis://test',
        workspaceBackend: 'aci',
        workspaceIdleTimeoutMs: idleTimeoutMs,
    });
    const restoreEntityStore = stubEntityStore({
        id: entityId,
        workspace: {
            url: 'http://workspace.test:3100',
            secret: 'secret-restarted',
            containerId: 'workspace-entity-restarted',
            shareName: 'workspace-entity-restarted',
            status: 'running',
        },
    });
    const originalFetch = global.fetch;
    const originalList = ACIBackend.prototype.listWorkspaceContainers;
    const originalRemove = ACIBackend.prototype.remove;
    const originalNow = Date.now;
    let removeCalled = false;

    workspaceClientModule.__testables.resetActivityStateForTest();
    workspaceClientModule.__testables.setActivityRedisClientForTest(fakeRedis);

    Date.now = () => now;
    ACIBackend.prototype.listWorkspaceContainers = undefined;
    global.fetch = async (url) => {
        const urlString = String(url);
        if (urlString.endsWith('/shell/jobs')) {
            return {
                ok: true,
                async json() {
                    return { jobs: [] };
                },
            };
        }
        if (urlString.endsWith('/health')) {
            return {
                ok: true,
                async json() {
                    return { version: '1.0.2' };
                },
            };
        }
        if (urlString.endsWith('/status')) {
            return {
                ok: true,
                async json() {
                    return { uptime: 123 };
                },
            };
        }
        if (urlString.endsWith('/backup')) {
            return {
                ok: true,
                async json() {
                    return { success: true, checkpoint: { sizeMB: 1.25 } };
                },
            };
        }
        t.fail(`unexpected fetch: ${urlString}`);
    };
    ACIBackend.prototype.remove = async (name) => {
        removeCalled = true;
        t.is(name, 'workspace-entity-restarted');
        return {};
    };

    try {
        await workspaceClientModule.__testables.reapIdleWorkspaces();

        t.true(removeCalled);
        t.false(workspaceClientModule.__testables.lastActivity.has(entityId));
        t.true(fakeRedis.calls.some(call => call.op === 'zrangebyscore' && call.key === 'test-cortex-workspace:activity-index'));
        t.true(fakeRedis.calls.some(call => call.op === 'zrem' && call.member === entityId));
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        Date.now = originalNow;
        ACIBackend.prototype.listWorkspaceContainers = originalList;
        ACIBackend.prototype.remove = originalRemove;
        global.fetch = originalFetch;
        restoreEntityStore();
        restoreConfig();
    }
});

test.serial('checkpointWorkspace uses /health version before calling /backup', async (t) => {
    const originalFetch = global.fetch;
    const calls = [];

    global.fetch = async (url) => {
        calls.push(String(url));
        if (String(url).endsWith('/health')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { status: 'ok', version: '1.0.6' };
                },
            };
        }
        if (String(url).endsWith('/status')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { uptime: 123 };
                },
            };
        }
        if (String(url).endsWith('/backup')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { path: '/persist/workspace.tar.gz', sizeMB: 12.3 };
                },
            };
        }
        t.fail(`unexpected fetch url ${url}`);
    };

    try {
        const result = await workspaceClientModule.__testables.checkpointWorkspace('entity-checkpoint', {
            workspace: {
                url: 'http://workspace.test:3100',
                secret: 'secret-checkpoint',
            },
        }, {
            uploadCheckpoint: async (_entityId, _workspace, body) => ({
                blobPath: 'workspace-checkpoints/test/entity-checkpoint/workspace.tar.gz',
                sizeBytes: body.sizeBytes || null,
                sizeMB: body.sizeMB || null,
                timestamp: body.timestamp || '2026-05-22T00:00:00.000Z',
            }),
        });

        t.true(result.success);
        t.falsy(result.skipped);
        t.is(result.checkpoint.blobPath, 'workspace-checkpoints/test/entity-checkpoint/workspace.tar.gz');
        t.deepEqual(calls, [
            'http://workspace.test:3100/health',
            'http://workspace.test:3100/status',
            'http://workspace.test:3100/backup',
        ]);
    } finally {
        global.fetch = originalFetch;
    }
});

test.serial('checkpointWorkspace uploads checkpoint directly to Blob URL', async (t) => {
    const originalFetch = global.fetch;
    const calls = [];
    const lifecycleEvents = [];

    global.fetch = async (url, options = {}) => {
        const urlString = String(url);
        calls.push({
            url: urlString,
            method: options.method,
            secret: options.headers?.['x-workspace-secret'],
            body: options.body,
        });
        if (urlString.endsWith('/health')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { status: 'ok', version: '1.0.7' };
                },
            };
        }
        if (urlString.endsWith('/status')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { uptime: 123 };
                },
            };
        }
        if (urlString.endsWith('/backup')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return {
                        path: '/persist/workspace.tar.gz',
                        sizeBytes: 16,
                        sizeMB: 0.01,
                        timestamp: '2026-05-22T00:00:00.000Z',
                    };
                },
            };
        }
        if (urlString.endsWith('/upload-url')) {
            const body = JSON.parse(options.body);
            t.is(options.method, 'POST');
            t.is(options.headers['x-workspace-secret'], 'secret-checkpoint');
            t.is(body.archiveUrl, 'https://storage.test/workspace.tar.gz?sas=write');
            t.is(body.archivePath, '/persist/workspace.tar.gz');
            t.is(body.metadata.entityId, 'entity-checkpoint');
            return {
                ok: true,
                status: 200,
                async json() {
                    return { message: 'uploaded', sizeBytes: 16 };
                },
            };
        }
        t.fail(`unexpected fetch url ${urlString}`);
    };

    try {
        const result = await workspaceClientModule.__testables.checkpointWorkspace('entity-checkpoint', {
            workspace: {
                url: 'http://workspace.test:3100',
                secret: 'secret-checkpoint',
            },
        }, {
            checkpointWriteSasUrl: 'https://storage.test/workspace.tar.gz?sas=write',
            onWorkspaceLifecycle: async (event) => lifecycleEvents.push(event),
        });

        t.true(result.success);
        t.is(
            result.checkpoint.blobPath,
            workspaceClientModule.__testables.workspaceCheckpointBlobPath('entity-checkpoint'),
        );
        t.deepEqual(calls.map(call => call.url), [
            'http://workspace.test:3100/health',
            'http://workspace.test:3100/status',
            'http://workspace.test:3100/backup',
            'http://workspace.test:3100/upload-url',
        ]);
        t.deepEqual(lifecycleEvents.map(event => [event.type, event.phase, event.success]), [
            ['start', 'checkpointBackup', undefined],
            ['finish', 'checkpointBackup', true],
            ['start', 'checkpointUpload', undefined],
            ['finish', 'checkpointUpload', true],
        ]);
    } finally {
        global.fetch = originalFetch;
    }
});

test.serial('checkpointWorkspace streams encrypted checkpoints on helper 1.0.10+', async (t) => {
    const originalFetch = global.fetch;
    const calls = [];
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        redisEncryptionKey: 'b'.repeat(64),
    });
    const store = stubMutableEntityStore({
        id: 'entity-encrypted-streaming-checkpoint',
        workspace: {
            url: 'http://workspace.test:3100',
            secret: 'secret-checkpoint',
        },
    });

    global.fetch = async (url, options = {}) => {
        const urlString = String(url);
        calls.push(urlString);
        if (urlString.endsWith('/health')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { status: 'ok', version: '1.0.10' };
                },
            };
        }
        if (urlString.endsWith('/status')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { uptime: 123 };
                },
            };
        }
        if (urlString.endsWith('/backup-upload-url')) {
            const body = JSON.parse(options.body);
            t.is(body.archiveUrl, 'https://storage.test/workspace.tar.gz?sas=write');
            t.is(body.metadata.entityId, 'entity-encrypted-streaming-checkpoint');
            t.is(body.metadata.checkpointEncrypted, 'true');
            t.is(body.encryption.algorithm, 'aes-256-gcm');
            t.is(Buffer.from(body.encryption.keyBase64, 'base64').length, 32);
            t.truthy(body.encryption.keyId);
            return {
                ok: true,
                status: 200,
                async json() {
                    return {
                        encrypted: true,
                        sizeBytes: 1234,
                        durationMs: 56,
                        encryption: {
                            algorithm: 'aes-256-gcm',
                            keyId: body.encryption.keyId,
                            ivBase64: Buffer.alloc(12, 5).toString('base64'),
                            tagBase64: Buffer.alloc(16, 6).toString('base64'),
                            compression: 'zstd',
                        },
                    };
                },
            };
        }
        t.fail(`unexpected fetch url ${urlString}`);
    };

    try {
        const result = await workspaceClientModule.__testables.checkpointWorkspace(
            'entity-encrypted-streaming-checkpoint',
            store.getEntity(),
            { checkpointWriteSasUrl: 'https://storage.test/workspace.tar.gz?sas=write' },
        );

        t.true(result.success);
        t.is(result.checkpoint.sizeBytes, 1234);
        t.is(result.checkpoint.encryption.algorithm, 'aes-256-gcm');
        t.is(result.checkpoint.encryption.compression, 'zstd');
        t.is(result.checkpoint.compression, 'zstd');
        t.is(store.getEntity().workspace.checkpointEncryptionKey.keyId, result.checkpoint.encryption.keyId);
        t.deepEqual(calls, [
            'http://workspace.test:3100/health',
            'http://workspace.test:3100/status',
            'http://workspace.test:3100/backup-upload-url',
        ]);
    } finally {
        global.fetch = originalFetch;
        store.restore();
        restoreConfig();
    }
});

test.serial('checkpointWorkspace does not reconfigure after encrypted upload timeout', async (t) => {
    const originalFetch = global.fetch;
    const calls = [];
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        redisEncryptionKey: 'b'.repeat(64),
    });
    const store = stubMutableEntityStore({
        id: 'entity-encrypted-streaming-timeout',
        workspace: {
            url: 'http://workspace.test:3100',
            secret: 'rotated-secret',
            bootstrapSecret: 'bootstrap-secret',
            containerId: 'workspace-entity-encrypted-streaming-timeout',
            status: 'running',
        },
    });

    global.fetch = async (url, options = {}) => {
        const urlString = String(url);
        calls.push({
            url: urlString,
            secret: options.headers?.['x-workspace-secret'],
            hasDispatcher: Boolean(options.dispatcher),
        });
        if (urlString.endsWith('/health')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { status: 'ok', version: '1.0.10' };
                },
            };
        }
        if (urlString.endsWith('/status')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { uptime: 123 };
                },
            };
        }
        if (urlString.endsWith('/backup-upload-url')) {
            const error = new Error('The operation was aborted due to timeout');
            error.name = 'TimeoutError';
            throw error;
        }
        t.fail(`unexpected fetch url ${urlString}`);
    };

    try {
        const result = await workspaceClientModule.__testables.checkpointWorkspace(
            'entity-encrypted-streaming-timeout',
            store.getEntity(),
            { checkpointWriteSasUrl: 'https://storage.test/workspace.tar.gz?sas=write' },
        );

        t.false(result.success);
        t.regex(result.error, /\/backup-upload-url timed out after 900s/);
        t.deepEqual(calls.map(call => call.url), [
            'http://workspace.test:3100/health',
            'http://workspace.test:3100/status',
            'http://workspace.test:3100/backup-upload-url',
        ]);
        t.is(calls[2].secret, 'rotated-secret');
        t.true(calls[2].hasDispatcher);
    } finally {
        global.fetch = originalFetch;
        store.restore();
        restoreConfig();
    }
});

test.serial('checkpointWorkspace retries upload-url fetch failure for Blob-only workspaces', async (t) => {
    const originalFetch = global.fetch;
    const calls = [];
    let uploadAttempts = 0;
    const entity = {
        id: 'entity-checkpoint-upload-retry',
        workspace: {
            url: 'http://workspace.test:3100',
            secret: 'secret-checkpoint',
        },
    };
    const restoreEntityStore = stubEntityStore(entity);

    global.fetch = async (url, options = {}) => {
        const urlString = String(url);
        calls.push(urlString);
        if (urlString.endsWith('/health')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { status: 'ok', version: '1.0.8' };
                },
            };
        }
        if (urlString.endsWith('/status')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { uptime: 123 };
                },
            };
        }
        if (urlString.endsWith('/backup')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return {
                        path: '/persist/workspace.tar.gz',
                        sizeBytes: 16,
                        sizeMB: 0.01,
                        timestamp: '2026-05-22T00:00:00.000Z',
                    };
                },
            };
        }
        if (urlString.endsWith('/upload-url')) {
            uploadAttempts += 1;
            t.is(options.headers['x-workspace-secret'], 'secret-checkpoint');
            if (uploadAttempts === 1) {
                throw new TypeError('fetch failed');
            }
            return {
                ok: true,
                status: 200,
                async json() {
                    return { message: 'uploaded', sizeBytes: 16 };
                },
            };
        }
        t.fail(`unexpected fetch url ${urlString}`);
    };

    try {
        const result = await workspaceClientModule.__testables.checkpointWorkspace(entity.id, entity, {
            checkpointWriteSasUrl: 'https://storage.test/workspace.tar.gz?sas=write',
        });

        t.true(result.success);
        t.is(result.checkpoint.sizeBytes, 16);
        t.is(uploadAttempts, 2);
        t.deepEqual(calls, [
            'http://workspace.test:3100/health',
            'http://workspace.test:3100/status',
            'http://workspace.test:3100/backup',
            'http://workspace.test:3100/upload-url',
            'http://workspace.test:3100/upload-url',
        ]);
    } finally {
        global.fetch = originalFetch;
        restoreEntityStore();
    }
});

test.serial('checkpointWorkspace recovers bootstrap auth after upload-url 401', async (t) => {
    const originalFetch = global.fetch;
    const entityId = 'entity-checkpoint-upload-auth-recovery';
    const calls = [];
    let uploadAttempts = 0;
    let freshSecret = null;
    const store = stubMutableEntityStore({
        id: entityId,
        workspace: {
            url: 'http://workspace.test:3100',
            secret: 'stale-secret',
            bootstrapSecret: 'bootstrap-secret',
            containerId: 'workspace-entity-checkpoint-upload-auth-recovery',
            status: 'running',
        },
    });

    global.fetch = async (url, options = {}) => {
        const urlString = String(url);
        calls.push({
            url: urlString,
            secret: options.headers?.['x-workspace-secret'],
        });
        if (urlString.endsWith('/health')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { status: 'ok', version: '1.0.8' };
                },
            };
        }
        if (urlString.endsWith('/status')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { uptime: 123 };
                },
            };
        }
        if (urlString.endsWith('/backup')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return {
                        path: '/persist/workspace.tar.gz',
                        sizeBytes: 16,
                        sizeMB: 0.01,
                        timestamp: '2026-05-22T00:00:00.000Z',
                    };
                },
            };
        }
        if (urlString.endsWith('/reconfigure')) {
            t.is(options.headers?.['x-workspace-secret'], 'bootstrap-secret');
            const body = JSON.parse(options.body);
            t.truthy(body.secret);
            freshSecret = body.secret;
            return {
                ok: true,
                status: 200,
                async json() {
                    return { success: true };
                },
            };
        }
        if (urlString.endsWith('/upload-url')) {
            uploadAttempts += 1;
            if (uploadAttempts === 1) {
                t.is(options.headers?.['x-workspace-secret'], 'stale-secret');
                return {
                    ok: false,
                    status: 401,
                    statusText: 'Unauthorized',
                    async json() {
                        return { error: 'Invalid secret' };
                    },
                };
            }
            t.is(options.headers?.['x-workspace-secret'], freshSecret);
            return {
                ok: true,
                status: 200,
                async json() {
                    return { message: 'uploaded', sizeBytes: 16 };
                },
            };
        }
        t.fail(`unexpected fetch url ${urlString}`);
    };

    try {
        const result = await workspaceClientModule.__testables.checkpointWorkspace(entityId, store.getEntity(), {
            checkpointWriteSasUrl: 'https://storage.test/workspace.tar.gz?sas=write',
        });

        t.true(result.success);
        t.is(result.checkpoint.sizeBytes, 16);
        t.is(uploadAttempts, 2);
        t.truthy(freshSecret);
        t.deepEqual(calls.map(call => call.url), [
            'http://workspace.test:3100/health',
            'http://workspace.test:3100/status',
            'http://workspace.test:3100/backup',
            'http://workspace.test:3100/upload-url',
            'http://workspace.test:3100/reconfigure',
            'http://workspace.test:3100/upload-url',
        ]);
    } finally {
        global.fetch = originalFetch;
        workspaceClientModule.__testables.resetActivityStateForTest();
        store.restore();
    }
});

test.serial('checkpointWorkspace recovers auth with bootstrap secret before backup', async (t) => {
    const entityId = 'entity-checkpoint-auth-recovery';
    const originalFetch = global.fetch;
    const calls = [];
    let freshSecret = null;
    const store = stubMutableEntityStore({
        id: entityId,
        workspace: {
            url: 'http://workspace.test:3100',
            secret: 'stale-secret',
            bootstrapSecret: 'bootstrap-secret',
            containerId: 'workspace-entity-checkpoint-auth-recovery',
            status: 'running',
            legacyShareName: 'workspace-legacy-share',
        },
    });

    workspaceClientModule.__testables.setWorkspaceCheckpointUploadForTest(async (_entityId, workspace, backupBody) => {
        t.is(_entityId, entityId);
        t.is(workspace.secret, freshSecret);
        t.is(backupBody.path, '/persist/workspace.tar.gz');
        return {
            blobPath: workspaceClientModule.__testables.workspaceCheckpointBlobPath(entityId),
            sizeBytes: 128,
        };
    });

    global.fetch = async (url, options = {}) => {
        const urlString = String(url);
        calls.push({
            url: urlString,
            secret: options.headers?.['x-workspace-secret'],
        });
        if (urlString.endsWith('/health')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { status: 'ok', version: '1.0.8' };
                },
            };
        }
        if (urlString.endsWith('/status') && options.headers?.['x-workspace-secret'] === 'stale-secret') {
            return {
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                async json() {
                    return { error: 'Invalid secret' };
                },
            };
        }
        if (urlString.endsWith('/reconfigure')) {
            t.is(options.headers?.['x-workspace-secret'], 'bootstrap-secret');
            const body = JSON.parse(options.body);
            t.truthy(body.secret);
            freshSecret = body.secret;
            return {
                ok: true,
                status: 200,
                async json() {
                    return { success: true };
                },
            };
        }
        if (urlString.endsWith('/status')) {
            t.is(options.headers?.['x-workspace-secret'], freshSecret);
            return {
                ok: true,
                status: 200,
                async json() {
                    return { uptime: 123, version: '1.0.8' };
                },
            };
        }
        if (urlString.endsWith('/backup')) {
            t.is(options.headers?.['x-workspace-secret'], freshSecret);
            return {
                ok: true,
                status: 200,
                async json() {
                    return {
                        path: '/persist/workspace.tar.gz',
                        sizeBytes: 128,
                        sizeMB: 0.01,
                        timestamp: '2026-05-22T00:00:00.000Z',
                    };
                },
            };
        }
        t.fail(`unexpected fetch url ${urlString}`);
    };

    try {
        const result = await workspaceClientModule.__testables.checkpointWorkspace(entityId, store.getEntity());

        t.true(result.success);
        t.is(result.checkpoint.sizeBytes, 128);
        t.truthy(freshSecret);
        t.deepEqual(calls.map(call => call.url), [
            'http://workspace.test:3100/health',
            'http://workspace.test:3100/status',
            'http://workspace.test:3100/reconfigure',
            'http://workspace.test:3100/status',
            'http://workspace.test:3100/backup',
        ]);
        t.is(calls[0].secret, 'stale-secret');
        t.is(calls[1].secret, 'stale-secret');
        t.is(calls[2].secret, 'bootstrap-secret');
        t.is(calls[3].secret, freshSecret);
        t.is(calls[4].secret, freshSecret);
    } finally {
        global.fetch = originalFetch;
        workspaceClientModule.__testables.resetActivityStateForTest();
        store.restore();
    }
});

test.serial('uploadWorkspaceCheckpoint marks streaming checkpoints at upload start', async (t) => {
    const entityId = 'entity-streaming-checkpoint-start';
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        redisEncryptionKey: 'd'.repeat(64),
    });
    const store = stubMutableEntityStore({
        id: entityId,
        workspace: {
            status: 'running',
        },
    });
    await workspaceClientModule.__testables.getOrCreateWorkspaceCheckpointEncryptionKey(entityId, store.getEntity());

    const originalFetch = global.fetch;
    let uploadBody = null;

    global.fetch = async (url, options = {}) => {
        const urlString = String(url);
        if (urlString.endsWith('/backup-upload-url')) {
            uploadBody = JSON.parse(options.body);
            return {
                ok: true,
                status: 200,
                async json() {
                    return {
                        encrypted: true,
                        sizeBytes: 128,
                        durationMs: 5000,
                        encryption: {
                            algorithm: 'aes-256-gcm',
                            keyId: uploadBody.encryption.keyId,
                            ivBase64: Buffer.alloc(12, 1).toString('base64'),
                            tagBase64: Buffer.alloc(16, 2).toString('base64'),
                            compression: 'gzip',
                        },
                    };
                },
            };
        }
        t.fail(`unexpected fetch url ${urlString}`);
    };

    try {
        const result = await workspaceClientModule.__testables.uploadWorkspaceCheckpoint(
            entityId,
            {
                url: 'http://workspace.test:3100',
                secret: 'workspace-secret',
            },
            null,
            900000,
            {
                checkpointWriteSasUrl: 'https://storage.test/workspace.tar.gz?sas=write',
                entityConfig: store.getEntity(),
            },
        );

        t.truthy(uploadBody.metadata.checkpointedAt);
        t.is(result.timestamp, uploadBody.metadata.checkpointedAt);
    } finally {
        global.fetch = originalFetch;
        workspaceClientModule.__testables.resetActivityStateForTest();
        store.restore();
        restoreConfig();
    }
});

test.serial('checkpointWorkspace copies legacy Azure Files checkpoint when workspace image lacks upload-url', async (t) => {
    const originalFetch = global.fetch;
    const calls = [];
    let legacyCopyCall = null;

    workspaceClientModule.__testables.setWorkspaceLegacyShareUploadForTest(async (call) => {
        legacyCopyCall = call;
        return {
            blobPath: call.blobPath,
            sizeBytes: 32,
        };
    });

    global.fetch = async (url, options = {}) => {
        const urlString = String(url);
        calls.push(urlString);
        if (urlString.endsWith('/health')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { status: 'ok', version: '1.0.7' };
                },
            };
        }
        if (urlString.endsWith('/status')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { uptime: 123 };
                },
            };
        }
        if (urlString.endsWith('/backup')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return {
                        path: '/persist/workspace.tar.gz',
                        sizeBytes: 32,
                        sizeMB: 0.01,
                        timestamp: '2026-05-22T00:00:00.000Z',
                    };
                },
            };
        }
        if (urlString.endsWith('/upload-url')) {
            return {
                ok: false,
                status: 404,
                statusText: 'Not Found',
                async json() {
                    return { error: 'not found' };
                },
            };
        }
        t.fail(`unexpected fetch url ${urlString}`);
    };

    try {
        const result = await workspaceClientModule.__testables.checkpointWorkspace('entity-legacy', {
            workspace: {
                url: 'http://workspace.test:3100',
                secret: 'secret-checkpoint',
                legacyShareName: 'workspace-legacy-share',
            },
        }, {
            checkpointWriteSasUrl: 'https://storage.test/workspace.tar.gz?sas=write',
        });

        t.true(result.success);
        t.is(result.checkpoint.sizeBytes, 32);
        t.is(legacyCopyCall.entityId, 'entity-legacy');
        t.is(legacyCopyCall.archivePath, '/persist/workspace.tar.gz');
        t.is(legacyCopyCall.shareName, 'workspace-legacy-share');
        t.is(
            legacyCopyCall.blobPath,
            workspaceClientModule.__testables.workspaceCheckpointBlobPath('entity-legacy'),
        );
        t.deepEqual(calls, [
            'http://workspace.test:3100/health',
            'http://workspace.test:3100/status',
            'http://workspace.test:3100/backup',
            'http://workspace.test:3100/upload-url',
        ]);
    } finally {
        global.fetch = originalFetch;
        workspaceClientModule.__testables.resetActivityStateForTest();
    }
});

test.serial('checkpointWorkspace copies legacy Azure Files checkpoint when upload-url fetch fails', async (t) => {
    const originalFetch = global.fetch;
    const calls = [];
    let legacyCopyCall = null;

    workspaceClientModule.__testables.setWorkspaceLegacyShareUploadForTest(async (call) => {
        legacyCopyCall = call;
        return {
            blobPath: call.blobPath,
            sizeBytes: 64,
        };
    });

    global.fetch = async (url) => {
        const urlString = String(url);
        calls.push(urlString);
        if (urlString.endsWith('/health')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { status: 'ok', version: '1.0.8' };
                },
            };
        }
        if (urlString.endsWith('/status')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { uptime: 123 };
                },
            };
        }
        if (urlString.endsWith('/backup')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return {
                        path: '/persist/workspace.tar.gz',
                        sizeBytes: 64,
                        sizeMB: 0.01,
                        timestamp: '2026-05-22T00:00:00.000Z',
                    };
                },
            };
        }
        if (urlString.endsWith('/upload-url')) {
            throw new TypeError('fetch failed');
        }
        t.fail(`unexpected fetch url ${urlString}`);
    };

    try {
        const result = await workspaceClientModule.__testables.checkpointWorkspace('entity-legacy-fetch-fail', {
            workspace: {
                url: 'http://workspace.test:3100',
                secret: 'secret-checkpoint',
                legacyShareName: 'workspace-legacy-share',
            },
        }, {
            checkpointWriteSasUrl: 'https://storage.test/workspace.tar.gz?sas=write',
        });

        t.true(result.success);
        t.is(result.checkpoint.sizeBytes, 64);
        t.is(legacyCopyCall.entityId, 'entity-legacy-fetch-fail');
        t.is(legacyCopyCall.archivePath, '/persist/workspace.tar.gz');
        t.is(legacyCopyCall.shareName, 'workspace-legacy-share');
        t.deepEqual(calls, [
            'http://workspace.test:3100/health',
            'http://workspace.test:3100/status',
            'http://workspace.test:3100/backup',
            'http://workspace.test:3100/upload-url',
        ]);
    } finally {
        global.fetch = originalFetch;
        workspaceClientModule.__testables.resetActivityStateForTest();
    }
});

test.serial('checkpointLegacyShareAfterProvision copies legacy archive directly to Blob', async (t) => {
    const entityId = 'entity-legacy-after-provision';
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: '',
        workspaceBackend: 'aci',
    });
    const store = stubMutableEntityStore({
        id: entityId,
        workspace: {
            url: 'http://workspace.test:3100',
            secret: 'workspace-secret',
            containerId: 'workspace-entity-legacy-after-provision',
            status: 'running',
            shareName: 'legacy-share-after-provision',
            legacyShareName: 'legacy-share-after-provision',
        },
    });
    const originalFetch = global.fetch;
    const uploads = [];
    const checkpointBlobPath = workspaceClientModule.__testables.workspaceCheckpointBlobPath(entityId);

    workspaceClientModule.__testables.setWorkspaceLegacyShareUploadForTest(async (call) => {
        uploads.push(call);
        return {
            blobPath: call.blobPath,
            sizeBytes: 4096,
        };
    });
    global.fetch = async (url) => {
        t.fail(`unexpected fetch: ${String(url)}`);
    };

    try {
        const result = await workspaceClientModule.__testables.checkpointLegacyShareAfterProvision(
            entityId,
            store.getEntity(),
        );

        t.true(result.success);
        t.is(uploads.length, 1);
        t.deepEqual(uploads[0], {
            entityId,
            workspace: {
                legacyShareName: 'legacy-share-after-provision',
            },
            shareName: 'legacy-share-after-provision',
            archivePath: '/persist/workspace.tar.gz',
            blobPath: checkpointBlobPath,
        });
        t.is(
            store.getEntity().workspace.checkpointBlobPath,
            checkpointBlobPath,
        );
        t.is(store.getEntity().workspace.legacyShareName, 'legacy-share-after-provision');
        t.false(Object.hasOwn(store.getEntity().workspace, 'shareName'));
    } finally {
        global.fetch = originalFetch;
        workspaceClientModule.__testables.resetActivityStateForTest();
        store.restore();
        restoreConfig();
    }
});

test.serial('restoreWorkspaceCheckpointToContainer restores checkpoint directly from Blob URL once', async (t) => {
    const originalFetch = global.fetch;
    const calls = [];
    const lifecycleEvents = [];

    global.fetch = async (url, options = {}) => {
        const urlString = String(url);
        calls.push({
            url: urlString,
            method: options.method,
            secret: options.headers?.['x-workspace-secret'],
        });
        if (urlString.endsWith('/restore-url')) {
            t.is(options.method, 'POST');
            t.is(options.headers['x-workspace-secret'], 'bootstrap-secret');
            t.deepEqual(JSON.parse(options.body), {
                archiveUrl: 'https://storage.test/workspace.tar.gz?sas=1',
                archivePath: '/persist/workspace.tar.gz',
            });
            return {
                ok: true,
                status: 200,
                async json() {
                    return { message: 'downloaded', sizeBytes: 16 };
                },
            };
        }
        if (urlString.endsWith('/restore')) {
            t.fail('/restore should not be called after /restore-url succeeds');
        }
        t.fail(`unexpected fetch url ${urlString}`);
    };

    try {
        const result = await workspaceClientModule.__testables.restoreWorkspaceCheckpointToContainer(
            'entity-restore',
            {
                workspace: {
                    checkpointBlobPath: 'workspace-checkpoints/test/entity-restore/workspace.tar.gz',
                    checkpointSizeBytes: 16,
                },
            },
            {
                url: 'http://workspace.test:3100',
                bootstrapSecret: 'bootstrap-secret',
            },
            {
                checkpointSasUrl: 'https://storage.test/workspace.tar.gz?sas=1',
                onWorkspaceLifecycle: async (event) => lifecycleEvents.push(event),
            },
        );

        t.true(result.success);
        t.deepEqual(calls.map(call => call.url), [
            'http://workspace.test:3100/restore-url',
        ]);
        t.deepEqual(lifecycleEvents.map(event => [event.type, event.phase, event.success]), [
            ['start', 'restore', undefined],
            ['finish', 'restore', true],
        ]);
    } finally {
        global.fetch = originalFetch;
    }
});

test.serial('restoreWorkspaceCheckpointToContainer passes encrypted checkpoint material to helper', async (t) => {
    const originalFetch = global.fetch;
    const restoreConfig = stubConfig({
        redisEncryptionKey: 'c'.repeat(64),
    });
    const store = stubMutableEntityStore({
        id: 'entity-restore-encrypted',
        workspace: {
            checkpointBlobPath: 'workspace-checkpoints/test/entity-restore-encrypted/workspace.tar.gz',
        },
    });
    const key = await workspaceClientModule.__testables.getOrCreateWorkspaceCheckpointEncryptionKey(
        'entity-restore-encrypted',
        store.getEntity(),
    );

    global.fetch = async (url, options = {}) => {
        const urlString = String(url);
        if (urlString.endsWith('/restore-url')) {
            const body = JSON.parse(options.body);
            t.is(body.archiveUrl, 'https://storage.test/workspace.tar.gz?sas=encrypted');
            t.is(body.archivePath, '/persist/workspace.tar.gz');
            t.is(body.encryption.algorithm, 'aes-256-gcm');
            t.is(body.encryption.keyBase64, key.keyBase64);
            t.is(body.encryption.keyId, key.keyId);
            t.is(body.encryption.ivBase64, Buffer.alloc(12, 7).toString('base64'));
            t.is(body.encryption.tagBase64, Buffer.alloc(16, 8).toString('base64'));
            t.is(body.encryption.compression, 'zstd');
            return {
                ok: true,
                status: 200,
                async json() {
                    return { message: 'restored encrypted', sizeBytes: 16 };
                },
            };
        }
        t.fail(`unexpected fetch url ${urlString}`);
    };

    try {
        const result = await workspaceClientModule.__testables.restoreWorkspaceCheckpointToContainer(
            'entity-restore-encrypted',
            {
                ...store.getEntity(),
                workspace: {
                    ...store.getEntity().workspace,
                    checkpointEncryption: {
                        algorithm: 'aes-256-gcm',
                        keyId: key.keyId,
                        ivBase64: Buffer.alloc(12, 7).toString('base64'),
                        tagBase64: Buffer.alloc(16, 8).toString('base64'),
                        compression: 'zstd',
                    },
                },
            },
            {
                url: 'http://workspace.test:3100',
                bootstrapSecret: 'bootstrap-secret',
            },
            { checkpointSasUrl: 'https://storage.test/workspace.tar.gz?sas=encrypted' },
        );

        t.true(result.success);
    } finally {
        global.fetch = originalFetch;
        store.restore();
        restoreConfig();
    }
});

test.serial('restoreWorkspaceCheckpointToContainer uses /restore only for old workspace images', async (t) => {
    const originalFetch = global.fetch;
    const calls = [];

    global.fetch = async (url, options = {}) => {
        const urlString = String(url);
        calls.push({
            url: urlString,
            method: options.method,
            secret: options.headers?.['x-workspace-secret'],
        });
        if (urlString.endsWith('/restore-url')) {
            return {
                ok: false,
                status: 404,
                statusText: 'Not Found',
                async json() {
                    return {};
                },
            };
        }
        if (urlString.endsWith('/shell')) {
            t.is(options.method, 'POST');
            t.is(options.headers['x-workspace-secret'], 'bootstrap-secret');
            t.regex(JSON.parse(options.body).command, /WORKSPACE_RESTORE_URL=/);
            return {
                ok: true,
                status: 200,
                async json() {
                    return { exitCode: 0 };
                },
            };
        }
        if (urlString.endsWith('/restore')) {
            t.is(options.method, 'POST');
            t.is(options.headers['x-workspace-secret'], 'bootstrap-secret');
            t.deepEqual(JSON.parse(options.body), { archivePath: '/persist/workspace.tar.gz' });
            return {
                ok: true,
                status: 200,
                async json() {
                    return { message: 'restored' };
                },
            };
        }
        t.fail(`unexpected fetch url ${urlString}`);
    };

    try {
        const result = await workspaceClientModule.__testables.restoreWorkspaceCheckpointToContainer(
            'entity-restore',
            {
                workspace: {
                    checkpointBlobPath: 'workspace-checkpoints/test/entity-restore/workspace.tar.gz',
                    checkpointSizeBytes: 16,
                },
            },
            {
                url: 'http://workspace.test:3100',
                bootstrapSecret: 'bootstrap-secret',
            },
            { checkpointSasUrl: 'https://storage.test/workspace.tar.gz?sas=1' },
        );

        t.true(result.success);
        t.deepEqual(calls.map(call => call.url), [
            'http://workspace.test:3100/restore-url',
            'http://workspace.test:3100/shell',
            'http://workspace.test:3100/restore',
        ]);
    } finally {
        global.fetch = originalFetch;
    }
});

test.serial('setupWorkspaceContainerForEntity rewrites env after restored checkpoint', async (t) => {
    const originalFetch = global.fetch;
    const calls = [];

    global.fetch = async (url, options = {}) => {
        const urlString = String(url);
        calls.push({ url: urlString, body: options.body ? JSON.parse(options.body) : null });
        if (urlString.endsWith('/restore-url')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { message: 'restored' };
                },
            };
        }
        if (urlString.endsWith('/reconfigure')) {
            t.deepEqual(JSON.parse(options.body).env, {});
            return {
                ok: true,
                status: 200,
                async json() {
                    return { success: true };
                },
            };
        }
        t.fail(`unexpected fetch url ${urlString}`);
    };

    const backend = {
        backendName: 'aci',
        async remove() {
            t.fail('setup should not remove a successfully configured container');
        },
    };
    const store = stubMutableEntityStore({
        id: 'entity-restore-env',
        secrets: {},
        assocUserIds: [],
        workspace: {
            checkpointBlobPath: 'workspace-checkpoints/test/entity-restore-env/workspace.tar.gz',
        },
    });

    try {
        const result = await workspaceClientModule.__testables.setupWorkspaceContainerForEntity(
            'entity-restore-env',
            store.getEntity(),
            {
                url: 'http://workspace.test:3100',
                bootstrapSecret: 'bootstrap-secret',
                containerId: 'workspace-entity-restore-env',
                containerName: 'workspace-entity-restore-env',
            },
            backend,
            { checkpointSasUrl: 'https://storage.test/workspace.tar.gz?sas=1' },
        );

        t.true(result.success);
        t.deepEqual(calls.map(call => call.url), [
            'http://workspace.test:3100/restore-url',
            'http://workspace.test:3100/reconfigure',
        ]);
    } finally {
        global.fetch = originalFetch;
        store.restore();
    }
});

test.serial('setupWorkspaceContainerForEntity restores mounted legacy share before reconfigure', async (t) => {
    const originalFetch = global.fetch;
    const calls = [];

    global.fetch = async (url, options = {}) => {
        const urlString = String(url);
        calls.push({ url: urlString, body: options.body ? JSON.parse(options.body) : null });
        if (urlString.endsWith('/shell')) {
            t.is(options.headers['x-workspace-secret'], 'bootstrap-secret');
            t.is(JSON.parse(options.body).command, "test -f '/persist/workspace.tar.gz'");
            return {
                ok: true,
                status: 200,
                async json() {
                    return { exitCode: 0 };
                },
            };
        }
        if (urlString.endsWith('/restore')) {
            t.is(options.headers['x-workspace-secret'], 'bootstrap-secret');
            t.deepEqual(JSON.parse(options.body), { archivePath: '/persist/workspace.tar.gz' });
            return {
                ok: true,
                status: 200,
                async json() {
                    return { message: 'restored legacy archive' };
                },
            };
        }
        if (urlString.endsWith('/reconfigure')) {
            t.deepEqual(JSON.parse(options.body).env, {});
            return {
                ok: true,
                status: 200,
                async json() {
                    return { success: true };
                },
            };
        }
        t.fail(`unexpected fetch url ${urlString}`);
    };

    const backend = {
        backendName: 'aci',
        async remove() {
            t.fail('setup should not remove a successfully configured container');
        },
    };
    const store = stubMutableEntityStore({
        id: 'entity-legacy-restore',
        secrets: {},
        assocUserIds: [],
        workspace: {
            shareName: 'legacy-share',
            legacyShareName: 'legacy-share',
        },
    });

    try {
        const result = await workspaceClientModule.__testables.setupWorkspaceContainerForEntity(
            'entity-legacy-restore',
            store.getEntity(),
            {
                url: 'http://workspace.test:3100',
                bootstrapSecret: 'bootstrap-secret',
                containerId: 'workspace-entity-legacy-restore',
                containerName: 'workspace-entity-legacy-restore',
                legacyShareName: 'legacy-share',
            },
            backend,
        );

        t.true(result.success);
        t.is(result.legacyShareName, 'legacy-share');
        t.deepEqual(calls.map(call => call.url), [
            'http://workspace.test:3100/shell',
            'http://workspace.test:3100/restore',
            'http://workspace.test:3100/reconfigure',
        ]);
    } finally {
        global.fetch = originalFetch;
        store.restore();
    }
});

test.serial('setupWorkspaceContainerForEntity preserves raw legacy shares without a tarball', async (t) => {
    const originalFetch = global.fetch;
    const calls = [];

    global.fetch = async (url, options = {}) => {
        const urlString = String(url);
        calls.push({ url: urlString, body: options.body ? JSON.parse(options.body) : null });
        if (urlString.endsWith('/shell')) {
            t.is(options.headers['x-workspace-secret'], 'bootstrap-secret');
            t.is(JSON.parse(options.body).command, "test -f '/persist/workspace.tar.gz'");
            return {
                ok: true,
                status: 200,
                async json() {
                    return { exitCode: 1 };
                },
            };
        }
        if (urlString.endsWith('/restore')) {
            t.fail('/restore should not be called when the legacy share has no tarball');
        }
        if (urlString.endsWith('/reconfigure')) {
            t.false(Object.hasOwn(JSON.parse(options.body), 'env'));
            return {
                ok: true,
                status: 200,
                async json() {
                    return { success: true };
                },
            };
        }
        t.fail(`unexpected fetch url ${urlString}`);
    };

    const backend = {
        backendName: 'aci',
        async remove() {
            t.fail('setup should not remove a raw legacy-share container');
        },
    };
    const store = stubMutableEntityStore({
        id: 'entity-legacy-raw',
        secrets: {},
        assocUserIds: [],
        workspace: {
            shareName: 'legacy-raw-share',
            legacyShareName: 'legacy-raw-share',
        },
    });

    try {
        const result = await workspaceClientModule.__testables.setupWorkspaceContainerForEntity(
            'entity-legacy-raw',
            store.getEntity(),
            {
                url: 'http://workspace.test:3100',
                bootstrapSecret: 'bootstrap-secret',
                containerId: 'workspace-entity-legacy-raw',
                containerName: 'workspace-entity-legacy-raw',
                legacyShareName: 'legacy-raw-share',
            },
            backend,
        );

        t.true(result.success);
        t.true(result.skipped);
        t.is(result.reason, 'legacy share has no checkpoint archive');
        t.deepEqual(calls.map(call => call.url), [
            'http://workspace.test:3100/shell',
            'http://workspace.test:3100/reconfigure',
        ]);
    } finally {
        global.fetch = originalFetch;
        store.restore();
    }
});

test.serial('workspaceRequest aborts stale image reprovision when checkpoint fails', async (t) => {
    const entityId = 'entity-stale-checkpoint-failure';
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: '',
        workspaceBackend: 'aci',
        workspaceImageVersion: '1.0.7',
        workspaceIdleTimeoutMs: 30 * 60 * 1000,
        warmPoolSize: 0,
    });
    const restoreEntityStore = stubEntityStore({
        id: entityId,
        workspace: {
            url: 'http://workspace.test:3100',
            secret: 'stale-secret',
            containerId: 'workspace-stale-checkpoint-failure',
            shareName: 'workspace-stale-checkpoint-failure',
            status: 'running',
            imageVersion: '1.0.6',
        },
    });
    const originalFetch = global.fetch;
    const originalGetContainerInfo = ACIBackend.prototype.getContainerInfo;
    const originalRemove = ACIBackend.prototype.remove;
    const originalCreateAndStart = ACIBackend.prototype.createAndStart;
    const lifecycleEvents = [];
    let createCalled = false;
    let removeCalled = false;

    workspaceClientModule.__testables.resetActivityStateForTest();
    global.fetch = async (url) => {
        const urlString = String(url);
        if (urlString.endsWith('/health')) {
            return {
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                async json() {
                    return { error: 'invalid workspace secret' };
                },
            };
        }
        t.fail(`unexpected fetch after checkpoint failure: ${urlString}`);
    };
    ACIBackend.prototype.remove = async () => {
        removeCalled = true;
        return {};
    };
    ACIBackend.prototype.getContainerInfo = async () => ({
        exists: true,
        name: 'workspace-stale-checkpoint-failure',
        url: 'http://workspace.test:3100',
    });
    ACIBackend.prototype.createAndStart = async () => {
        createCalled = true;
        throw new Error('provision should not run after checkpoint failure');
    };

    try {
        const result = await workspaceClientModule.workspaceRequest(entityId, '/health', null, {
            onWorkspaceLifecycle(event) {
                lifecycleEvents.push(event);
            },
        });

        t.false(result.success);
        t.true(result.error.includes('/health returned 401'));
        t.false(removeCalled);
        t.false(createCalled);
        t.deepEqual(
            lifecycleEvents.map(({ type, phase, success }) => ({ type, phase, success })),
            [
                { type: 'start', phase: 'reprovision', success: undefined },
                { type: 'finish', phase: 'reprovision', success: false },
            ],
        );
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        ACIBackend.prototype.getContainerInfo = originalGetContainerInfo;
        ACIBackend.prototype.remove = originalRemove;
        ACIBackend.prototype.createAndStart = originalCreateAndStart;
        global.fetch = originalFetch;
        restoreEntityStore();
        restoreConfig();
    }
});

test.serial('workspaceRequest recovers bootstrap auth after refreshed ACI URL returns 401', async (t) => {
    const entityId = 'entity-request-url-refresh-auth-recovery';
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: '',
        workspaceBackend: 'aci',
        workspaceImageVersion: '1.0.14',
        workspaceCpus: '1',
        workspaceMemory: '512m',
        workspaceDiskSize: '10g',
        warmPoolSize: 0,
    });
    const store = stubMutableEntityStore({
        id: entityId,
        secrets: null,
        workspace: {
            url: 'http://old-ip.test:3100',
            secret: 'stale-secret',
            bootstrapSecret: 'bootstrap-secret',
            containerId: 'workspace-url-refresh-auth-recovery',
            status: 'running',
            imageVersion: '1.0.14',
        },
    });
    const originalFetch = global.fetch;
    const originalGetContainerUrl = ACIBackend.prototype.getContainerUrl;
    const originalRemove = ACIBackend.prototype.remove;
    const originalCreateAndStart = ACIBackend.prototype.createAndStart;
    const calls = [];
    let freshSecret = null;
    let removeCalled = false;
    let createCalled = false;

    ACIBackend.prototype.getContainerUrl = async function (containerId) {
        calls.push({ type: 'getContainerUrl', containerId });
        return 'http://new-ip.test:3100';
    };
    ACIBackend.prototype.remove = async () => {
        removeCalled = true;
        throw new Error('reprovision should not remove the live workspace');
    };
    ACIBackend.prototype.createAndStart = async () => {
        createCalled = true;
        throw new Error('reprovision should not create a replacement workspace');
    };

    global.fetch = async (url, options = {}) => {
        const urlString = String(url);
        calls.push({
            type: 'fetch',
            url: urlString,
            secret: options.headers?.['x-workspace-secret'],
        });

        if (urlString === 'http://old-ip.test:3100/health') {
            throw new TypeError('fetch failed');
        }

        if (urlString === 'http://new-ip.test:3100/health' &&
            options.headers?.['x-workspace-secret'] === 'stale-secret') {
            return {
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
                async json() {
                    return { error: 'Invalid secret' };
                },
            };
        }

        if (urlString === 'http://new-ip.test:3100/reconfigure') {
            t.is(options.headers?.['x-workspace-secret'], 'bootstrap-secret');
            const body = JSON.parse(options.body);
            t.truthy(body.secret);
            freshSecret = body.secret;
            return {
                ok: true,
                status: 200,
                async json() {
                    return { success: true };
                },
            };
        }

        if (urlString === 'http://new-ip.test:3100/health' &&
            options.headers?.['x-workspace-secret'] === freshSecret) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { status: 'ok' };
                },
            };
        }

        t.fail(`unexpected fetch url ${urlString}`);
    };

    try {
        const result = await workspaceClientModule.workspaceRequest(entityId, '/health');

        t.true(result.success);
        t.is(result.status, 'ok');
        t.is(store.getEntity().workspace.url, 'http://new-ip.test:3100');
        t.is(store.getEntity().workspace.secret, freshSecret);
        t.false(removeCalled);
        t.false(createCalled);
        t.deepEqual(
            calls
                .filter(call => call.type === 'fetch')
                .map(call => `${call.url} ${call.secret}`),
            [
                'http://old-ip.test:3100/health stale-secret',
                'http://new-ip.test:3100/health stale-secret',
                'http://new-ip.test:3100/reconfigure bootstrap-secret',
                `http://new-ip.test:3100/health ${freshSecret}`,
            ],
        );
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        ACIBackend.prototype.getContainerUrl = originalGetContainerUrl;
        ACIBackend.prototype.remove = originalRemove;
        ACIBackend.prototype.createAndStart = originalCreateAndStart;
        global.fetch = originalFetch;
        store.restore();
        restoreConfig();
    }
});

test.serial('workspaceRequest stale image reprovision proceeds without background-job gate', async (t) => {
    const entityId = 'entity-stale-image-running-job';
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: '',
        workspaceBackend: 'aci',
        workspaceImage: 'cortex-workspace',
        workspaceImageVersion: '1.0.14',
        workspaceCpus: '1',
        workspaceMemory: '512m',
        workspaceDiskSize: '10g',
        warmPoolSize: 0,
    });
    const store = stubMutableEntityStore({
        id: entityId,
        workspace: {
            url: 'http://old-workspace.test:3100',
            secret: 'old-secret',
            bootstrapSecret: 'old-bootstrap-secret',
            containerId: 'workspace-old-running-job',
            status: 'running',
            imageVersion: '1.0.12',
        },
    });
    const originalFetch = global.fetch;
    const originalGetContainerInfo = ACIBackend.prototype.getContainerInfo;
    const originalRemove = ACIBackend.prototype.remove;
    const originalCreateAndStart = ACIBackend.prototype.createAndStart;
    const removedContainers = [];
    const fetchCalls = [];
    let freshSecret = null;

    workspaceClientModule.__testables.setWorkspaceCheckpointUploadForTest(async () => ({
        blobPath: 'workspace-checkpoints/test-cortex/entity-stale-image-running-job/workspace.tar.gz',
        sizeBytes: 128,
        sizeMB: 0.01,
        timestamp: '2026-06-26T12:00:00.000Z',
    }));

    ACIBackend.prototype.remove = async function (containerId, containerName) {
        removedContainers.push({ containerId, containerName });
    };
    ACIBackend.prototype.getContainerInfo = async () => ({
        exists: true,
        name: 'workspace-old-running-job',
        url: 'http://old-workspace.test:3100',
    });
    ACIBackend.prototype.createAndStart = async function (args) {
        return {
            containerId: args.containerName,
            url: 'http://new-workspace.test:3100',
        };
    };

    global.fetch = async (url, options = {}) => {
        const urlString = String(url);
        fetchCalls.push(urlString);
        if (urlString.endsWith('/shell/jobs')) {
            t.fail('stale image reprovision should not block on running background jobs');
        }

        if (urlString === 'http://old-workspace.test:3100/health') {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { version: '1.0.12' };
                },
            };
        }
        if (urlString === 'http://old-workspace.test:3100/status') {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { version: '1.0.12' };
                },
            };
        }
        if (urlString === 'http://old-workspace.test:3100/backup') {
            return {
                ok: true,
                status: 200,
                async json() {
                    return {
                        path: '/persist/workspace.tar.gz',
                        sizeBytes: 128,
                        timestamp: '2026-06-26T12:00:00.000Z',
                    };
                },
            };
        }
        if (urlString === 'http://new-workspace.test:3100/health' && !options.headers?.['x-workspace-secret']) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { ok: true };
                },
            };
        }
        if (urlString === 'http://new-workspace.test:3100/restore-url') {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { sizeBytes: 128 };
                },
            };
        }
        if (urlString === 'http://new-workspace.test:3100/reconfigure') {
            t.regex(options.headers?.['x-workspace-secret'], /^[0-9a-f]{64}$/);
            const body = JSON.parse(options.body);
            freshSecret = body.secret;
            return {
                ok: true,
                status: 200,
                async json() {
                    return { success: true };
                },
            };
        }
        if (urlString === 'http://new-workspace.test:3100/health') {
            t.is(options.headers?.['x-workspace-secret'], freshSecret);
            return {
                ok: true,
                status: 200,
                async json() {
                    return { ok: true };
                },
            };
        }

        t.fail(`unexpected fetch url ${urlString}`);
    };

    try {
        const result = await workspaceClientModule.workspaceRequest(entityId, '/health', null, {
            checkpointSasUrl: 'https://checkpoint.example/workspace.tar.gz?sas',
        });

        t.true(result.success);
        t.deepEqual(removedContainers, [{
            containerId: 'workspace-old-running-job',
            containerName: 'workspace-old-running-job',
        }]);
        t.is(store.getEntity().workspace.url, 'http://new-workspace.test:3100');
        t.is(store.getEntity().workspace.imageVersion, '1.0.14');
        t.false(fetchCalls.some(url => url.endsWith('/shell/jobs')));
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        ACIBackend.prototype.getContainerInfo = originalGetContainerInfo;
        ACIBackend.prototype.remove = originalRemove;
        ACIBackend.prototype.createAndStart = originalCreateAndStart;
        global.fetch = originalFetch;
        store.restore();
        restoreConfig();
    }
});

test.serial('workspaceRequest stale image self-heals when the recorded ACI container is missing', async (t) => {
    const entityId = 'entity-stale-missing-container';
    const legacyShareName = 'workspace-pool-legacy-share';
    const restoreConfig = stubConfig({
        cortexId: 'test-cortex',
        storageConnectionString: '',
        workspaceBackend: 'aci',
        workspaceContainerPrefix: 'workspace-dev',
        workspaceImage: 'cortex-workspace',
        workspaceImageVersion: '1.0.14',
        workspaceCpus: '1',
        workspaceMemory: '512m',
        workspaceDiskSize: '10g',
        warmPoolSize: 0,
    });
    const store = stubMutableEntityStore({
        id: entityId,
        workspace: {
            url: 'http://old-missing-workspace.test:3100',
            secret: 'old-secret',
            bootstrapSecret: 'old-bootstrap-secret',
            containerId: `workspace-${entityId}`,
            shareName: legacyShareName,
            status: 'running',
            imageVersion: '1.0.7',
        },
    });
    const originalFetch = global.fetch;
    const originalGetContainerInfo = ACIBackend.prototype.getContainerInfo;
    const originalRemove = ACIBackend.prototype.remove;
    const originalCreateAndStart = ACIBackend.prototype.createAndStart;
    const createdContainers = [];
    const removedContainers = [];
    const fetchCalls = [];
    let freshSecret = null;

    workspaceClientModule.__testables.setWorkspaceLegacyShareUploadForTest(async ({ shareName, blobPath }) => {
        t.is(shareName, legacyShareName);
        return {
            blobPath,
            sizeBytes: 128,
        };
    });

    ACIBackend.prototype.getContainerInfo = async function (containerId, containerName) {
        t.is(containerId, `workspace-${entityId}`);
        t.is(containerName, `workspace-${entityId}`);
        return { exists: false, name: containerName, url: null };
    };
    ACIBackend.prototype.remove = async function (containerId, containerName) {
        removedContainers.push({ containerId, containerName });
    };
    ACIBackend.prototype.createAndStart = async function (args) {
        createdContainers.push(args);
        return {
            containerId: args.containerName,
            url: 'http://new-workspace.test:3100',
        };
    };

    global.fetch = async (url, options = {}) => {
        const urlString = String(url);
        fetchCalls.push(urlString);
        if (urlString.startsWith('http://old-missing-workspace.test')) {
            t.fail(`stale missing workspace should not be contacted: ${urlString}`);
        }

        if (urlString === 'http://new-workspace.test:3100/health' && !options.headers?.['x-workspace-secret']) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { ok: true };
                },
            };
        }
        if (urlString === 'http://new-workspace.test:3100/shell') {
            t.is(options.headers?.['x-workspace-secret'], createdContainers[0]?.env?.[0]?.replace('WORKSPACE_SECRET=', ''));
            return {
                ok: true,
                status: 200,
                async json() {
                    return { exitCode: 1 };
                },
            };
        }
        if (urlString === 'http://new-workspace.test:3100/reconfigure') {
            t.is(options.headers?.['x-workspace-secret'], createdContainers[0]?.env?.[0]?.replace('WORKSPACE_SECRET=', ''));
            const body = JSON.parse(options.body);
            freshSecret = body.secret;
            return {
                ok: true,
                status: 200,
                async json() {
                    return { success: true };
                },
            };
        }
        if (urlString === 'http://new-workspace.test:3100/backup-upload-url') {
            t.is(options.headers?.['x-workspace-secret'], freshSecret);
            return {
                ok: true,
                status: 200,
                async json() {
                    return {
                        sizeBytes: 128,
                        encryption: {
                            algorithm: 'aes-256-gcm',
                            keyId: 'test-key',
                            ivBase64: Buffer.alloc(12).toString('base64'),
                            tagBase64: Buffer.alloc(16).toString('base64'),
                        },
                    };
                },
            };
        }
        if (urlString === 'http://new-workspace.test:3100/health') {
            t.is(options.headers?.['x-workspace-secret'], freshSecret);
            return {
                ok: true,
                status: 200,
                async json() {
                    return { ok: true };
                },
            };
        }

        t.fail(`unexpected fetch url ${urlString}`);
    };

    try {
        const result = await workspaceClientModule.workspaceRequest(entityId, '/health');

        t.true(result.success);
        t.is(removedContainers.length, 0);
        t.is(createdContainers.length, 1);
        t.is(createdContainers[0].containerName, `workspace-dev-${entityId}`);
        t.is(createdContainers[0].shareName, legacyShareName);
        t.true(createdContainers[0].mountAzureFiles);
        t.false(fetchCalls.some(url => url.startsWith('http://old-missing-workspace.test')));
        t.is(store.getEntity().workspace.containerId, `workspace-dev-${entityId}`);
        t.is(store.getEntity().workspace.imageVersion, '1.0.14');
    } finally {
        workspaceClientModule.__testables.resetActivityStateForTest();
        ACIBackend.prototype.getContainerInfo = originalGetContainerInfo;
        ACIBackend.prototype.remove = originalRemove;
        ACIBackend.prototype.createAndStart = originalCreateAndStart;
        global.fetch = originalFetch;
        store.restore();
        restoreConfig();
    }
});
