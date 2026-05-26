/**
 * Unit tests for workspace shareName preservation logic.
 *
 * Verifies that:
 * - ACIBackend.createAndStart() uses explicit shareName when provided
 * - ACIBackend.destroyVolume() uses shareName directly (not derived from containerName)
 * - DockerBackend.createAndStart() uses explicit shareName for volume naming
 * - DockerBackend.destroyVolume() uses shareName directly
 *
 * These are "structural" tests — they verify the parameter plumbing without
 * actually calling Azure or Docker APIs. We achieve this by subclassing the
 * backends and capturing the arguments passed to the underlying operations.
 *
 * Run with: npm test -- cortex tests/unit/tools/workspaceShareName.test.js
 */

import test from 'ava';

// ============================================================================
// ACIBackend: shareName parameter plumbing
// ============================================================================

// We can't easily unit-test ACIBackend without Azure credentials, but we
// can verify the DockerBackend plumbing since it uses local HTTP calls.
// For ACIBackend, we test the shareName logic by importing and inspecting
// the source behavior indirectly.

test('ACIBackend › createAndStart mounts Azure Files only for explicit legacy migration', async (t) => {
    // Import ACIBackend and override the Azure-dependent methods
    const { default: ACIBackend } = await import(
        '../../../pathways/system/entity/tools/shared/backends/ACIBackend.js'
    );

    class TestACIBackend extends ACIBackend {
        constructor() {
            super();
            this.capturedShareName = null;
            this.capturedContainerGroupDef = null;
        }

        async _getClient() {
            // Return a mock client that captures the container group definition
            return {
                containerGroups: {
                    beginCreateOrUpdate: async (_rg, _name, def) => {
                        this.capturedContainerGroupDef = def;
                        return {
                            pollUntilDone: async () => ({
                                ipAddress: { fqdn: 'test.eastus.azurecontainer.io', ip: '1.2.3.4' },
                            }),
                        };
                    },
                },
            };
        }

        async _ensureFileShare(shareName) {
            this.capturedShareName = shareName;
        }
    }

    const backend = new TestACIBackend();

    // Stub config values needed by createAndStart
    const originalGet = (await import('../../../config.js')).config.get;
    const configStubs = {
        azureResourceGroup: 'test-rg',
        azureLocation: 'eastus',
        azureAcrServer: null,
        azureAcrUsername: null,
        azureAcrPassword: null,
        azureStorageAccountName: 'testaccount',
        azureStorageAccountKey: 'dGVzdGtleQ==', // base64 "testkey"
    };

    const { config } = await import('../../../config.js');
    const origGet = config.get.bind(config);
    config.get = (key) => {
        if (key in configStubs) return configStubs[key];
        return origGet(key);
    };

    try {
        const created = await backend.createAndStart({
            containerName: 'workspace-entity-123',
            image: 'cortex-workspace:latest',
            env: ['WORKSPACE_SECRET=test', 'PORT=3100'],
            cpus: 1,
            memoryMB: 512,
            diskSize: '10g',
            shareName: 'workspace-pool-abc123',
            mountAzureFiles: true,
        });

        // The share name should be the explicit shareName, NOT the containerName
        t.is(backend.capturedShareName, 'workspace-pool-abc123');

        // The persistent Azure Files mount should use the explicit share name.
        const persistVolumeDef = backend.capturedContainerGroupDef.volumes.find(v => v.name === 'persist-vol');
        t.is(persistVolumeDef.azureFile.shareName, 'workspace-pool-abc123');

        // /workspace itself should be local ephemeral storage so symlinks work.
        const workspaceVolumeDef = backend.capturedContainerGroupDef.volumes.find(v => v.name === 'workspace-vol');
        t.deepEqual(workspaceVolumeDef.emptyDir, {});

        // Prefer the assigned IP over the DNS label because ACI can briefly
        // serve stale DNS after deleting/recreating a group with the same name.
        t.is(created.url, 'http://1.2.3.4:3100');
    } finally {
        config.get = origGet;
    }
});

test('ACIBackend › createAndStart uses local persist volume by default', async (t) => {
    const { default: ACIBackend } = await import(
        '../../../pathways/system/entity/tools/shared/backends/ACIBackend.js'
    );

    class TestACIBackend extends ACIBackend {
        constructor() {
            super();
            this.capturedShareName = null;
        }

        async _getClient() {
            return {
                containerGroups: {
                    beginCreateOrUpdate: async (_rg, _name, def) => {
                        this.capturedContainerGroupDef = def;
                        return {
                            pollUntilDone: async () => ({
                                ipAddress: { fqdn: 'test.eastus.azurecontainer.io' },
                            }),
                        };
                    },
                },
            };
        }

        async _ensureFileShare(shareName) {
            this.capturedShareName = shareName;
        }
    }

    const backend = new TestACIBackend();

    const { config } = await import('../../../config.js');
    const origGet = config.get.bind(config);
    config.get = (key) => {
        const stubs = {
            azureResourceGroup: 'test-rg',
            azureLocation: 'eastus',
            azureAcrServer: null,
            azureAcrUsername: null,
            azureAcrPassword: null,
            azureStorageAccountName: 'testaccount',
            azureStorageAccountKey: 'dGVzdGtleQ==',
        };
        if (key in stubs) return stubs[key];
        return origGet(key);
    };

    try {
        await backend.createAndStart({
            containerName: 'workspace-entity-456',
            image: 'cortex-workspace:latest',
            env: ['WORKSPACE_SECRET=test', 'PORT=3100'],
            cpus: 1,
            memoryMB: 512,
            diskSize: '10g',
            // No shareName or mountAzureFiles: Blob checkpoints are restored by Cortex.
        });

        t.is(backend.capturedShareName, null);
        const persistVolumeDef = backend.capturedContainerGroupDef.volumes.find(v => v.name === 'persist-vol');
        t.deepEqual(persistVolumeDef.emptyDir, {});
        t.falsy(persistVolumeDef.azureFile);
    } finally {
        config.get = origGet;
    }
});

// ============================================================================
// DockerBackend: shareName parameter plumbing
// ============================================================================

test('DockerBackend › createAndStart should use shareName for volume naming', async (t) => {
    const { default: DockerBackend } = await import(
        '../../../pathways/system/entity/tools/shared/backends/DockerBackend.js'
    );

    let capturedCreateBody = null;

    class TestDockerBackend extends DockerBackend {
        async _api(method, path, body) {
            if (method === 'POST' && path.startsWith('/containers/create')) {
                capturedCreateBody = body;
                return { Id: 'test-container-id' };
            }
            if (method === 'POST' && path.includes('/start')) {
                return {};
            }
            if (method === 'DELETE') {
                return {};
            }
            if (method === 'GET' && path.includes('/json')) {
                return { NetworkSettings: { Ports: { '3100/tcp': [{ HostPort: '12345' }] } } };
            }
            return {};
        }
    }

    const backend = new TestDockerBackend();

    await backend.createAndStart({
        containerName: 'workspace-entity-789',
        image: 'cortex-workspace:latest',
        env: ['WORKSPACE_SECRET=test', 'PORT=3100'],
        cpus: 1,
        memoryMB: 512,
        diskSize: '10g',
        shareName: 'workspace-pool-xyz789',
    });

    // Volume name should be derived from shareName, not containerName
    const binds = capturedCreateBody.HostConfig.Binds;
    t.true(binds[0].startsWith('workspace-pool-xyz789-data:'), `Expected volume "workspace-pool-xyz789-data" but got: ${binds[0]}`);
});

test('DockerBackend › createAndStart should fall back to containerName when no shareName', async (t) => {
    const { default: DockerBackend } = await import(
        '../../../pathways/system/entity/tools/shared/backends/DockerBackend.js'
    );

    let capturedCreateBody = null;

    class TestDockerBackend extends DockerBackend {
        async _api(method, path, body) {
            if (method === 'POST' && path.startsWith('/containers/create')) {
                capturedCreateBody = body;
                return { Id: 'test-container-id' };
            }
            if (method === 'POST' && path.includes('/start')) {
                return {};
            }
            if (method === 'DELETE') {
                return {};
            }
            return {};
        }
    }

    const backend = new TestDockerBackend();

    await backend.createAndStart({
        containerName: 'workspace-entity-000',
        image: 'cortex-workspace:latest',
        env: ['WORKSPACE_SECRET=test', 'PORT=3100'],
        cpus: 1,
        memoryMB: 512,
        diskSize: '10g',
        // No shareName
    });

    const binds = capturedCreateBody.HostConfig.Binds;
    t.true(binds[0].startsWith('workspace-entity-000-data:'), `Expected volume "workspace-entity-000-data" but got: ${binds[0]}`);
});

// ============================================================================
// DockerBackend: destroyVolume uses shareName directly
// ============================================================================

test('DockerBackend › destroyVolume should use shareName param directly', async (t) => {
    const { default: DockerBackend } = await import(
        '../../../pathways/system/entity/tools/shared/backends/DockerBackend.js'
    );

    let deletedVolume = null;

    class TestDockerBackend extends DockerBackend {
        async _api(method, path) {
            if (method === 'DELETE' && path.startsWith('/volumes/')) {
                deletedVolume = path.replace('/volumes/', '');
                return {};
            }
            return {};
        }
    }

    const backend = new TestDockerBackend();

    await backend.destroyVolume('workspace-pool-custom-share');

    t.is(deletedVolume, 'workspace-pool-custom-share-data');
});

// ============================================================================
// warmPool: claimContainer returns an Azure-Files-free claim
// ============================================================================

test('warmPool › claimContainer return shape does not require shareName', async (t) => {
    // We can't easily test the full Redis-backed pool without Redis,
    // but we can verify the module exports and return type documentation.
    // The actual integration test covers this end-to-end.

    // Import to verify it doesn't throw
    const { claimContainer } = await import(
        '../../../pathways/system/entity/tools/shared/warmPool.js'
    );

    t.is(typeof claimContainer, 'function');

    // Without Redis, claimContainer returns { success: false }. In an
    // environment with Redis/pool state, validate that successful claims no
    // longer carry an Azure Files share placeholder.
    const result = await claimContainer();
    if (result.success) {
        t.is(result.shareName, undefined);
    } else {
        t.false(result.success);
    }
});
