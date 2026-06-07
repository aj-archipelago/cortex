/**
 * Workspace Integration Tests
 *
 * These tests verify that the workspace container system works end-to-end.
 * Self-contained: boots its own Cortex server via serverFactory().
 *
 * Requirements:
 * - Docker running locally (or DOCKER_HOST pointing to a remote Docker)
 * - cortex-workspace:latest image available
 * - Redis + MongoDB configured (via root .env)
 * - Filehandler service (only for files push/pull and backup/restore tests)
 *
 * Run with:
 * node -r dotenv/config ./node_modules/ava/entrypoints/cli.mjs tests/integration/workspace.integration.test.js --timeout=300s --concurrency=1
 */

import test from 'ava';
import { v4 as uuidv4 } from 'uuid';
import serverFactory from '../../index.js';
import { stopWorkspace, destroyWorkspace } from '../../pathways/system/entity/tools/shared/workspace_client.js';
import { loadEntityConfig } from '../../pathways/system/entity/tools/shared/sys_entity_tools.js';
import { getEntityStore } from '../../lib/MongoEntityStore.js';

const TEST_ENTITY_ID = process.env.TEST_ENTITY_ID || 'jarvis';

let testServer;

// Helper to call workspace SSH tool via Apollo executeOperation
async function workspaceExec(command, options = {}) {
    const query = `query {
        sys_tool_workspace_ssh(
            command: ${JSON.stringify(command)},
            userMessage: "test",
            entityId: "${options.entityId || TEST_ENTITY_ID}"
            ${options.contextId ? `, contextId: "${options.contextId}"` : ''}
            ${options.userId ? `, userId: "${options.userId}"` : ''}
            ${options.chatId ? `, chatId: "${options.chatId}"` : ''}
        ) { result }
    }`;

    const response = await testServer.executeOperation({ query });

    const errors = response.body?.singleResult?.errors;
    if (errors) {
        throw new Error(`GraphQL error: ${JSON.stringify(errors)}`);
    }

    return JSON.parse(response.body.singleResult.data.sys_tool_workspace_ssh.result);
}

// ============================================================================
// Setup / Teardown
// ============================================================================

test.before(async (t) => {
    t.timeout(300_000); // ACI provisioning can take 30-90s
    try {
        const { server, startServer } = await serverFactory();
        startServer && await startServer();
        testServer = server;
    } catch (e) {
        t.log(`Failed to start Cortex server: ${e.message}`);
        t.log('Ensure MongoDB is configured and Docker is running');
        throw e;
    }

    // Warm up: trigger workspace provisioning so tests don't individually timeout.
    // ACI containers may need two attempts — the first provisions but may not pass
    // health check in time; the second finds the container already running.
    t.log('Warming up workspace (provisioning if needed)...');
    for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await workspaceExec('echo "workspace ready"');
        if (result.success) {
            t.log('Workspace ready');
            break;
        }
        if (attempt === 3) {
            t.log(`Workspace warm-up failed after ${attempt} attempts: ${JSON.stringify(result)}`);
            throw new Error(`Workspace not ready: ${result.error}`);
        }
        t.log(`Workspace warm-up attempt ${attempt} failed, retrying...`);
    }
});

test.after.always(async () => {
    if (!testServer) return;

    // Destroy the workspace container so the next run starts fresh.
    // The reconfigure tests rotate the container's in-memory secret;
    // if the container persists across runs (or Docker restarts it),
    // the env-var secret and MongoDB secret will be out of sync.
    try {
        await destroyWorkspace(TEST_ENTITY_ID);
    } catch {
        // Best-effort cleanup
    }

    await testServer.stop();
});

// ============================================================================
// Basic Shell Operations
// ============================================================================

test.serial('shell › should execute simple commands', async (t) => {
    const result = await workspaceExec('echo "hello workspace"');

    t.true(result.success);
    t.is(result.stdout.trim(), 'hello workspace');
    t.is(result.exitCode, 0);
});

test.serial('shell › should report command failures', async (t) => {
    const result = await workspaceExec('bash -c "exit 42"');

    // Non-zero exit code is still a "success" from execution perspective
    t.is(result.exitCode, 42);
});

test.serial('shell › should handle complex pipelines', async (t) => {
    const result = await workspaceExec('echo -e "c\\nb\\na" | sort | head -1');

    t.true(result.success);
    t.is(result.stdout.trim(), 'a');
});

// ============================================================================
// File Operations
// ============================================================================

test.serial('files › should create and read files', async (t) => {
    // Create file
    const createResult = await workspaceExec('echo "test content" > /workspace/test_file.txt');
    t.true(createResult.success);

    // Read file
    const readResult = await workspaceExec('cat /workspace/test_file.txt');
    t.true(readResult.success);
    t.is(readResult.stdout.trim(), 'test content');
});

test.serial('files › should create directories', async (t) => {
    const result = await workspaceExec('mkdir -p /workspace/test_dir/nested && ls -la /workspace/test_dir');

    t.true(result.success);
    t.true(result.stdout.includes('nested'));
});

test.serial('files › should handle binary files', async (t) => {
    // Create a small binary file using base64 decode, verify with xxd or od
    const createResult = await workspaceExec('echo "iVBORw0KGgo=" | base64 -d > /workspace/test.bin && wc -c < /workspace/test.bin');

    t.true(createResult.success);
    // Should have written some bytes
    t.true(parseInt(createResult.stdout.trim()) > 0);
});

// ============================================================================
// Background Jobs
// ============================================================================

test.serial('background › should run jobs in background', async (t) => {
    // Start background job
    const bgResult = await workspaceExec('bg sleep 1 && echo "bg done" > /workspace/bg_marker.txt');

    t.true(bgResult.success);
    t.truthy(bgResult.processId);

    // Wait and poll
    await new Promise(resolve => setTimeout(resolve, 2000));

    const pollResult = await workspaceExec(`poll ${bgResult.processId}`);

    t.true(pollResult.success);
    t.is(pollResult.status, 'completed');
});

// ============================================================================
// Git Operations
// ============================================================================

test.serial('git › should initialize and commit', async (t) => {
    const commands = [
        'mkdir -p /workspace/git_test',
        'cd /workspace/git_test && git init',
        'cd /workspace/git_test && git config user.email "test@test.com"',
        'cd /workspace/git_test && git config user.name "Test"',
        'echo "# Test" > /workspace/git_test/README.md',
        'cd /workspace/git_test && git add . && git commit -m "Initial"',
    ].join(' && ');

    const result = await workspaceExec(commands);
    t.true(result.success);

    // Verify commit exists
    const logResult = await workspaceExec('cd /workspace/git_test && git log --oneline');
    t.true(logResult.success);
    t.true(logResult.stdout.includes('Initial'));
});

// ============================================================================
// Network Access
// ============================================================================

test.serial('network › should access external URLs', async (t) => {
    const result = await workspaceExec('curl -s https://httpbin.org/get | head -5');

    t.true(result.success);
    t.true(result.stdout.includes('args') || result.stdout.includes('headers'));
});

// ============================================================================
// Workspace Reset
// ============================================================================

test.serial('reset › should clear workspace contents', async (t) => {
    // Create some files first
    await workspaceExec('echo "to be deleted" > /workspace/delete_me.txt');

    // Reset
    const resetResult = await workspaceExec('reset');

    t.true(resetResult.success);
    t.true(resetResult.message.includes('reset'));

    // Verify files are gone
    const lsResult = await workspaceExec('ls /workspace');
    t.true(lsResult.success);
    t.false(lsResult.stdout.includes('delete_me.txt'));
});

// ============================================================================
// Stop / Wake-on-Demand (idle management)
// ============================================================================

test.serial('idle › should stop and auto-wake workspace', async (t) => {
    t.timeout(180_000); // docker: ~20s; ACI: stop (~5s) + start (~30-60s) + health check
    // Create a marker file to verify data persistence across stop/start
    const createResult = await workspaceExec('echo "survive stop" > /workspace/persist_test.txt');
    t.true(createResult.success);

    // Stop the workspace directly
    const entityConfig = await loadEntityConfig(TEST_ENTITY_ID);
    t.truthy(entityConfig?.workspace?.containerId, 'Workspace should have a containerId');

    const stopResult = await stopWorkspace(TEST_ENTITY_ID, entityConfig);
    t.true(stopResult.success);

    // Verify entity status is now 'stopped'
    const stoppedConfig = await loadEntityConfig(TEST_ENTITY_ID);
    t.is(stoppedConfig.workspace.status, 'stopped');
    t.truthy(stoppedConfig.workspace.stoppedAt);

    // Execute a command — this should trigger wake-on-demand automatically.
    // ACI stop/start preserves the container, but not necessarily uncheckpointed
    // local workspace files. Reprovision/checkpoint coverage below verifies
    // persisted data restoration for ACI.
    const isAci = (process.env.WORKSPACE_BACKEND || 'docker') === 'aci';
    const wakeResult = await workspaceExec(isAci ? 'echo "awake"' : 'cat /workspace/persist_test.txt');
    t.true(wakeResult.success);
    t.is(wakeResult.stdout.trim(), isAci ? 'awake' : 'survive stop');

    // Verify entity status is back to 'running'
    const runningConfig = await loadEntityConfig(TEST_ENTITY_ID);
    t.is(runningConfig.workspace.status, 'running');
});

// ============================================================================
// Reconfigure endpoint (secret rotation + env injection)
// ============================================================================

test.serial('reconfigure > should rotate secret', async (t) => {
    t.timeout(60_000);

    // Load entity config to get current workspace URL + secret
    const entityConfig = await loadEntityConfig(TEST_ENTITY_ID);
    t.truthy(entityConfig?.workspace?.url, 'Workspace must be provisioned');
    t.truthy(entityConfig?.workspace?.secret, 'Workspace must have a secret');

    const { url, secret: oldSecret } = entityConfig.workspace;
    const newSecret = `rotated-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Call /reconfigure with the old secret to rotate to the new secret
    const reconfigResponse = await fetch(`${url}/reconfigure`, {
        method: 'POST',
        headers: {
            'x-workspace-secret': oldSecret,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ secret: newSecret }),
    });

    t.is(reconfigResponse.status, 200);
    const reconfigResult = await reconfigResponse.json();
    t.true(reconfigResult.success);

    // Verify old secret is rejected
    const oldSecretResponse = await fetch(`${url}/status`, {
        headers: { 'x-workspace-secret': oldSecret },
    });
    t.is(oldSecretResponse.status, 401, 'Old secret should be rejected after rotation');

    // Verify new secret is accepted
    const newSecretResponse = await fetch(`${url}/status`, {
        headers: { 'x-workspace-secret': newSecret },
    });
    t.is(newSecretResponse.status, 200, 'New secret should be accepted after rotation');

    // Update entity config in MongoDB so subsequent tests use the new secret
    const entityStore = getEntityStore();
    await entityStore.upsertEntity({
        ...entityConfig,
        workspace: { ...entityConfig.workspace, secret: newSecret },
    });
});

test.serial('reconfigure > should inject env vars', async (t) => {
    t.timeout(60_000);

    // Load entity config with the (possibly rotated) secret
    const entityConfig = await loadEntityConfig(TEST_ENTITY_ID);
    const { url, secret } = entityConfig.workspace;

    // Call /reconfigure to inject env vars
    const reconfigResponse = await fetch(`${url}/reconfigure`, {
        method: 'POST',
        headers: {
            'x-workspace-secret': secret,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            env: { TEST_RECONFIG_VAR: 'hello_from_reconfigure' },
        }),
    });

    t.is(reconfigResponse.status, 200);
    const reconfigResult = await reconfigResponse.json();
    t.true(reconfigResult.success);

    // Verify /workspace/.env contains the var
    const catResult = await workspaceExec('cat /workspace/.env');
    t.true(catResult.success);
    t.true(catResult.stdout.includes('TEST_RECONFIG_VAR'), '.env should contain TEST_RECONFIG_VAR');
    t.true(catResult.stdout.includes('hello_from_reconfigure'), '.env should contain the value');

    // Verify the var is accessible when .env is sourced
    const shellResult = await workspaceExec('. /workspace/.env && echo $TEST_RECONFIG_VAR');
    t.true(shellResult.success);
    t.is(shellResult.stdout.trim(), 'hello_from_reconfigure');
});

// ============================================================================
// Per-User Blob Mount (private entity with single user association)
// ============================================================================

test.serial('blob mount › public entity should have no blob mount', async (t) => {
    // The default test entity (jarvis) is public — no assocUserIds
    // Verify /workspace/files/ is NOT a blobfuse2 mount
    const result = await workspaceExec('mount | grep blobfuse2 || echo "no blobfuse2 mount"');

    t.true(result.success);
    t.true(result.stdout.includes('no blobfuse2 mount'));
});

test.serial('blob mount › private entity should get per-user blob mount', async (t) => {
    if ((process.env.WORKSPACE_BACKEND || 'docker') !== 'aci') {
        t.log('Skipping: blob mount requires ACI backend (blobfuse2 is not configured on Docker)');
        t.pass();
        return;
    }
    t.timeout(300_000);

    const privateEntityId = `test-private-${uuidv4().slice(0, 8)}`;
    const testUserId = `test-user-${uuidv4().slice(0, 8)}`;

    // Create a private entity with a single user association
    const entityStore = getEntityStore();
    await entityStore.upsertEntity({
        id: privateEntityId,
        name: 'Test Private Entity',
        assocUserIds: [testUserId],
        tools: ['workspacessh'],
    });

    try {
        // Provision workspace — should get a per-user blob mount
        t.log(`Provisioning private entity ${privateEntityId} with user ${testUserId}...`);
        for (let attempt = 1; attempt <= 3; attempt++) {
            const result = await workspaceExec('echo "ready"', { entityId: privateEntityId });
            if (result.success) break;
            if (attempt === 3) throw new Error(`Private entity workspace not ready: ${result.error}`);
            t.log(`Attempt ${attempt} failed, retrying...`);
        }

        // Verify blobfuse2 mount exists
        const mountResult = await workspaceExec(
            'mount | grep blobfuse2 || echo "no blobfuse2 mount"',
            { entityId: privateEntityId },
        );
        t.true(mountResult.success);
        t.true(mountResult.stdout.includes('blobfuse2'), 'Should have a blobfuse2 mount');
        t.true(mountResult.stdout.includes('/workspace/files'), 'Mount should be at /workspace/files');

        // Verify we can write and read through the mount
        const writeResult = await workspaceExec(
            'echo "blob mount test" > /workspace/files/test_blob.txt && cat /workspace/files/test_blob.txt',
            { entityId: privateEntityId },
        );
        t.true(writeResult.success);
        t.is(writeResult.stdout.trim(), 'blob mount test');

        // Verify the container env doesn't have the account key (only SAS token)
        const envResult = await workspaceExec('env | grep AZURE_STORAGE_ACCOUNT_KEY || echo "no account key"', {
            entityId: privateEntityId,
        });
        t.true(envResult.success);
        t.true(envResult.stdout.includes('no account key'), 'Account key should NOT be in env');
    } finally {
        // Clean up: destroy the private entity's workspace and remove the entity
        try {
            const entityConfig = await loadEntityConfig(privateEntityId);
            if (entityConfig?.workspace) {
                await destroyWorkspace(privateEntityId, entityConfig, { destroyVolume: true });
            }
            await entityStore.deleteEntity(privateEntityId);
        } catch {
            // Best-effort cleanup
        }
    }
});

// ============================================================================
// Destroy/reprovision — destroys ACI containers and rewakes via preserved storage
// ============================================================================

test.serial('destroy › ACI workspace is destroyed and rewakes from preserved checkpoint', async (t) => {
    if ((process.env.WORKSPACE_BACKEND || 'docker') !== 'aci') {
        t.log('Skipping: only relevant for ACI backend (Docker keeps stop semantics)');
        t.pass();
        return;
    }
    t.timeout(600_000); // provision + destroy + reprovision can run long on ACI

    const reaperEntityId = `test-reaper-${uuidv4().slice(0, 8)}`;
    const entityStore = getEntityStore();

    await entityStore.upsertEntity({
        id: reaperEntityId,
        name: 'Test Reaper Entity',
        tools: ['workspacessh'],
    });

    let provisionedShareName = null;

    try {
        // 1. Provision the workspace
        t.log(`Provisioning ${reaperEntityId}...`);
        for (let attempt = 1; attempt <= 3; attempt++) {
            const result = await workspaceExec('echo "ready"', { entityId: reaperEntityId });
            if (result.success) break;
            if (attempt === 3) throw new Error(`Workspace not ready: ${result.error}`);
        }

        // 2. Write a marker into the workspace so destroy/provision must preserve it.
        const markerWrite = await workspaceExec(
            'echo "survive-reap-destroy" > /workspace/reaper_marker.txt',
            { entityId: reaperEntityId },
        );
        t.true(markerWrite.success, 'should write marker file');

        const beforeReap = await loadEntityConfig(reaperEntityId);
        t.truthy(beforeReap?.workspace?.containerId, 'should have containerId before reap');
        t.is(beforeReap.workspace.status, 'running');
        provisionedShareName = beforeReap.workspace.shareName || beforeReap.workspace.containerId;
        t.truthy(provisionedShareName, 'should have a persistence handle before reap');

        t.log('Destroying workspace while preserving storage...');
        const destroyResult = await destroyWorkspace(reaperEntityId, beforeReap, { destroyVolume: false });
        t.true(destroyResult.success, destroyResult.error || 'destroy should preserve workspace storage');

        // 4. Assert the entity workspace was reduced to a persistence handle.
        // Current ACI images preserve Blob checkpoints; legacy images may preserve Azure Files shares.
        const afterReap = await loadEntityConfig(reaperEntityId);
        t.truthy(afterReap?.workspace, 'workspace stub should remain');
        const afterReapHandle = afterReap.workspace.checkpointBlobPath || afterReap.workspace.shareName;
        t.truthy(afterReapHandle, 'workspace persistence handle preserved');
        if (afterReap.workspace.shareName) {
            t.is(afterReap.workspace.shareName, provisionedShareName, 'shareName preserved');
        }
        t.falsy(afterReap.workspace.containerId, 'containerId should be cleared');
        t.falsy(afterReap.workspace.url, 'url should be cleared');

        // 5. Trigger workspace use → must auto-reprovision and restore preserved storage.
        t.log('Triggering reprovision via workspace use...');
        const rewakeRead = await workspaceExec(
            'cat /workspace/reaper_marker.txt',
            { entityId: reaperEntityId },
        );
        t.true(rewakeRead.success, 'reprovisioned workspace should respond');
        t.is(rewakeRead.stdout.trim(), 'survive-reap-destroy', 'marker survives reprovision');

        // 6. Sanity: new container has a (possibly different) containerId
        const afterRewake = await loadEntityConfig(reaperEntityId);
        t.truthy(afterRewake?.workspace?.containerId, 'should have containerId after rewake');
        t.is(afterRewake.workspace.status, 'running');
        if (afterReap.workspace.shareName) {
            t.is(
                afterRewake.workspace.shareName || afterRewake.workspace.containerId,
                provisionedShareName,
                'rewake remounts the same share',
            );
        } else {
            t.is(afterRewake.workspace.checkpointBlobPath, afterReap.workspace.checkpointBlobPath, 'rewake preserves the same checkpoint');
        }
    } finally {
        // Clean up: destroy workspace AND volume, delete entity
        try {
            const finalConfig = await loadEntityConfig(reaperEntityId);
            if (finalConfig?.workspace) {
                await destroyWorkspace(reaperEntityId, finalConfig, { destroyVolume: true });
            } else if (provisionedShareName) {
                // Workspace was already torn down (e.g. test failed mid-way) but
                // share may linger. Best-effort: synthesize enough config to nuke it.
                await destroyWorkspace(reaperEntityId, {
                    workspace: { shareName: provisionedShareName },
                }, { destroyVolume: true });
            }
            await entityStore.deleteEntity(reaperEntityId);
        } catch (e) {
            t.log(`Cleanup error (best-effort): ${e.message}`);
        }
    }
});
