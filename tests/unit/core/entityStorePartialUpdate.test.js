import test from 'ava';
import { MongoEntityStore } from '../../../lib/MongoEntityStore.js';

// Test the upsertEntity partial-update logic in isolation by simulating
// the field-merge behavior without needing a real MongoDB connection.

function buildDoc(entity, existingEntity) {
    const base = existingEntity || {};
    const pick = (key, fallback) =>
        Object.hasOwn(entity, key) ? entity[key] : (base[key] ?? fallback);

    return {
        id: entity.id,
        name: pick('name', 'Unnamed Entity') || 'Unnamed Entity',
        isDefault: pick('isDefault', false),
        isSystem: pick('isSystem', false),
        useMemory: pick('useMemory', true),
        description: pick('description', ''),
        identity: Object.hasOwn(entity, 'identity')
            ? (entity.identity || '')
            : Object.hasOwn(entity, 'instructions')
                ? (entity.instructions || '')
                : (base.identity ?? ''),
        avatar: pick('avatar', null),
        voice: pick('voice', null),
        tools: pick('tools', ['*']),
        resources: Object.hasOwn(entity, 'resources')
            ? (entity.resources || [])
            : Object.hasOwn(entity, 'files')
                ? (entity.files || [])
                : (base.resources ?? []),
        customTools: pick('customTools', {}),
        requiredEnvVars: pick('requiredEnvVars', []),
        assocUserIds: pick('assocUserIds', []),
        createdBy: pick('createdBy', null),
        baseModel: pick('baseModel', null),
        preferredModel: pick('preferredModel', null),
        modelOverride: pick('modelOverride', null),
        reasoningEffort: pick('reasoningEffort', null),
        workspace: pick('workspace', null),
        secrets: pick('secrets', null),
    };
}

test('upsertEntity rejects id-less unnamed partial updates', async t => {
    const store = new MongoEntityStore();
    store.isConfigured = () => true;
    store._getCollection = async () => ({
        updateOne: async () => t.fail('partial update should not create a new entity'),
    });

    const result = await store.upsertEntity({
        workspace: {
            checkpointBlobPath: 'workspace-checkpoints/test/entity/workspace.tar.gz',
        },
    });

    t.is(result, null);
});

test('partial update preserves workspace when not provided', t => {
    const existing = {
        id: 'test-123',
        name: 'Old Name',
        workspace: { url: 'http://ws:3100', shareName: 'ws-share', status: 'running' },
        secrets: { API_KEY: 'encrypted-value' },
        assocUserIds: ['user-abc'],
        createdBy: 'user-abc',
        tools: ['WorkspaceSSH', 'WebSearch'],
        requiredEnvVars: ['SECRET_ONE'],
    };

    const doc = buildDoc({ id: 'test-123', name: 'New Name' }, existing);

    t.is(doc.name, 'New Name');
    t.deepEqual(doc.workspace, existing.workspace);
    t.deepEqual(doc.secrets, existing.secrets);
    t.deepEqual(doc.assocUserIds, existing.assocUserIds);
    t.is(doc.createdBy, existing.createdBy);
    t.deepEqual(doc.tools, existing.tools);
    t.deepEqual(doc.requiredEnvVars, existing.requiredEnvVars);
});

test('partial update allows explicitly setting workspace to null', t => {
    const existing = {
        id: 'test-123',
        workspace: { url: 'http://ws:3100', shareName: 'ws-share' },
    };

    const doc = buildDoc({ id: 'test-123', workspace: null }, existing);
    t.is(doc.workspace, null);
});

test('partial update allows explicitly setting workspace to new value', t => {
    const existing = {
        id: 'test-123',
        workspace: { url: 'http://old:3100', shareName: 'old-share' },
    };
    const newWorkspace = { url: 'http://new:3100', shareName: 'new-share', status: 'running' };

    const doc = buildDoc({ id: 'test-123', workspace: newWorkspace }, existing);
    t.deepEqual(doc.workspace, newWorkspace);
});

test('partial update allows explicitly clearing required env vars', t => {
    const existing = {
        id: 'test-123',
        requiredEnvVars: ['SECRET_ONE'],
    };

    const doc = buildDoc({ id: 'test-123', requiredEnvVars: [] }, existing);
    t.deepEqual(doc.requiredEnvVars, []);
});

test('full entity update works as before', t => {
    const full = {
        id: 'test-123',
        name: 'Entity',
        isDefault: false,
        isSystem: false,
        useMemory: true,
        description: 'desc',
        identity: 'instructions here',
        avatar: null,
        voice: null,
        tools: ['*'],
        resources: [],
        customTools: {},
        requiredEnvVars: ['SECRET_ONE', 'SECRET_TWO'],
        assocUserIds: ['user-1'],
        createdBy: 'user-1',
        baseModel: null,
        preferredModel: null,
        modelOverride: null,
        reasoningEffort: null,
        workspace: { url: 'http://ws:3100' },
        secrets: { KEY: 'val' },
    };

    const doc = buildDoc(full, null);

    t.is(doc.name, 'Entity');
    t.deepEqual(doc.workspace, { url: 'http://ws:3100' });
    t.deepEqual(doc.secrets, { KEY: 'val' });
    t.deepEqual(doc.assocUserIds, ['user-1']);
    t.is(doc.createdBy, 'user-1');
    t.deepEqual(doc.requiredEnvVars, ['SECRET_ONE', 'SECRET_TWO']);
});

test('new entity (no existing) gets proper defaults', t => {
    const doc = buildDoc({ id: 'new-entity' }, null);

    t.is(doc.name, 'Unnamed Entity');
    t.is(doc.workspace, null);
    t.is(doc.secrets, null);
    t.deepEqual(doc.assocUserIds, []);
    t.is(doc.createdBy, null);
    t.deepEqual(doc.tools, ['*']);
    t.deepEqual(doc.requiredEnvVars, []);
    t.is(doc.useMemory, true);
});

test('instructions field maps to identity for backward compat', t => {
    const doc = buildDoc({ id: 'x', instructions: 'Be helpful' }, null);
    t.is(doc.identity, 'Be helpful');
});

test('identity takes precedence over instructions', t => {
    const doc = buildDoc({ id: 'x', identity: 'Custom', instructions: 'Ignored' }, null);
    t.is(doc.identity, 'Custom');
});

test('preserves identity from existing when neither provided', t => {
    const existing = { id: 'x', identity: 'Existing instructions' };
    const doc = buildDoc({ id: 'x', name: 'Rename' }, existing);
    t.is(doc.identity, 'Existing instructions');
});
