import test from 'ava';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
let server, client, fixtureId = 0;
test.before(async () => { server = await MongoMemoryServer.create(); client = await MongoClient.connect(server.getUri()); });
test.after.always(async () => { await client?.close(); await server?.stop(); });
import storeMemory from '../../../pathways/system/entity/tools/sys_tool_store_memory.js';
import { memoryArgs } from '../../../lib/entityPreferences.js';
import {
    manageColleagues,
    resolveColleagueWorkspace,
    colleagueDirectory,
} from '../../../lib/colleagues.js';
import {
    validateWatchPath,
    watchCommand,
} from '../../../lib/colleagueWatch.js';

const personal = {
    id: 'personal',
    personalOwnerId: 'user-a',
    assocUserIds: ['user-a'],
};

test('memory calls use the entity namespace without changing workspace access', t => {
    const args = { contextId: 'owner', memoryContextId: 'colleague-memory', contextKey: 'key', fileAccessPlan: [{ userContextId: 'owner' }] };
    const scoped = memoryArgs(args);
    t.is(scoped.contextId, 'colleague-memory');
    t.is(scoped.contextKey, args.contextKey);
    t.deepEqual(scoped.fileAccessPlan, args.fileAccessPlan);
    t.is(args.contextId, 'owner');
});

test('turning off learning rejects explicit StoreMemory writes', async t => {
    const result = await storeMemory.executePathway({ args: {
        memoryLearning: false, contextId: 'owner', memoryContextId: 'colleague-memory',
        memories: [{ content: 'Do not persist this', section: 'memoryUser' }],
    } });
    t.regex(JSON.parse(result).error, /learning is disabled/);
});
function fixture() {
    const entities = new Map([[personal.id, personal]]);
    const preferences = new Map();
    const collection = client.db("colleague_test").collection(`fixture-${fixtureId++}`);
    const store = {
        _getCollection: async () => { await collection.deleteMany({}); await collection.insertMany([...entities.values()].map(e => ({ ...e }))); return collection; },
        entityPreferences: async () => ({
            find: ({ _id }) => ({ toArray: async () => _id.$in.map(id => preferences.get(id)).filter(Boolean) }),
            findOne: async ({ _id }) => preferences.get(_id),
            updateOne: async ({ _id }, { $set }) => preferences.set(_id, { _id, ...preferences.get(_id), ...$set }),
        }),
        getEntity: async (id) => entities.get(id),
        getAllEntities: async () => [...entities.values()],
        upsertEntity: async (entity, { insertOnly = false } = {}) => {
            if (insertOnly && entities.has(entity.id)) return entity.id;
            entities.set(entity.id, { ...entities.get(entity.id), ...entity });
            return entity.id;
        },
    };
    const resolvePersonal = async () => ({
        entityId: personal.id,
        entityConfig: personal,
    });
    return { entities, store, resolvePersonal };
}

test('colleagues keep distinct identities and share one validated workspace owner', async (t) => {
    const { store, resolvePersonal } = fixture();
    const a = await manageColleagues(
        store,
        {
            userId: 'user-a',
            action: 'create',
            settings: JSON.stringify({
                name: 'Noor',
                instructions: 'Research carefully',
                avatar: 'orbit',
                workspaceOwnerId: 'attacker',
                personalOwnerId: 'user-a',
            }),
        },
        resolvePersonal,
    );
    const b = await manageColleagues(
        store,
        { userId: 'user-a', action: 'create', settings: '{"name":"Mira"}' },
        resolvePersonal,
    );
    t.not(a.id, b.id);
    for (const colleague of [a, b]) {
        const entity = await store.getEntity(colleague.id);
        t.is(entity.personalOwnerId, undefined);
        t.is(entity.workspace, undefined);
        t.deepEqual(entity.tools, ['*']);
        const binding = await resolveColleagueWorkspace(
            entity.id,
            store.getEntity,
        );
        t.is(binding.entityId, personal.id);
        t.is(binding.directory, colleagueDirectory(entity.id));
    }
    t.not(a.directory, b.directory);
    t.is(a.instructions, 'Research carefully');
});

test('personal and shared entities allow personal options but no identity or lifecycle edits', async t => {
    const { store, entities, resolvePersonal } = fixture();
    entities.set('shared', { id: 'shared', name: 'Shared specialist', assocUserIds: [] });
    const result = await manageColleagues(store, { userId: 'user-a', action: 'list' }, resolvePersonal);
    t.is(result.colleagues[0].kind, 'personal');
    t.is(result.colleagues[0].avatar, 'personal');
    await t.throwsAsync(manageColleagues(store, { userId: 'user-a', action: 'update', entityId: 'personal', settings: '{"avatar":"orbit"}' }), { message: /reserved gold/ });
    const gold = await manageColleagues(store, { userId: 'user-a', action: 'update', entityId: 'personal', settings: '{"avatar":"personal"}' });
    t.is(gold.avatar, 'personal');
    await t.throwsAsync(manageColleagues(store, { userId: 'user-a', action: 'create', settings: '{"name":"Gold imposter","avatar":"personal"}' }, resolvePersonal), { message: 'Invalid avatar' });
    t.is(result.colleagues[0].memoryContextId, 'user-a');
    t.false(result.colleagues.find(e => e.id === 'shared').editable);
    await manageColleagues(store, { userId: 'user-a', action: 'update', entityId: 'shared', settings: JSON.stringify({ model: 'model-a', memoryLearning: false }) });
    const a = await manageColleagues(store, { userId: 'user-a', action: 'list' });
    const b = await manageColleagues(store, { userId: 'user-b', action: 'list' });
    t.is(a.colleagues.find(e => e.id === 'shared').model, 'model-a');
    t.is(b.colleagues.find(e => e.id === 'shared').model, null);
    t.not(a.colleagues.find(e => e.id === 'shared').memoryContextId, b.colleagues[0].memoryContextId);
    await t.throwsAsync(manageColleagues(store, { userId: 'user-a', action: 'update', entityId: 'shared', settings: '{"name":"Changed"}' }));
    await t.throwsAsync(manageColleagues(store, { userId: 'user-a', action: 'update', entityId: 'personal', settings: '{"status":"archived"}' }));
});

test('colleagues have separate stable memories and invalid model updates do not mutate identity', async t => {
    const { store, resolvePersonal } = fixture();
    const create = name => manageColleagues(store, { userId: 'user-a', action: 'create', settings: JSON.stringify({ name }) }, resolvePersonal);
    const a = await create('A');
    const b = await create('B');
    t.not(a.memoryContextId, b.memoryContextId);
    t.not(a.memoryContextId, 'user-a');
    const updated = await manageColleagues(store, { userId: 'user-a', action: 'update', entityId: a.id, settings: '{"name":"Renamed","model":"model-a","reasoningEffort":"high","memoryLearning":false}' }, resolvePersonal, m => m === 'model-a');
    t.is(updated.memoryContextId, a.memoryContextId);
    t.is(updated.model, 'model-a');
    t.false(updated.memoryLearning);
    await t.throwsAsync(manageColleagues(store, { userId: 'user-a', action: 'update', entityId: a.id, settings: '{"name":"Bad rename","model":"invalid"}' }, resolvePersonal, () => false));
    t.is((await store.getEntity(a.id)).name, 'Renamed');
});

test('management rejects cross-owner edits and hides other owners in listings', async (t) => {
    const { store, resolvePersonal } = fixture();
    const a = await manageColleagues(
        store,
        { userId: 'user-a', action: 'create', settings: '{"name":"Noor"}' },
        resolvePersonal,
    );
    await t.throwsAsync(
        manageColleagues(store, {
            userId: 'user-b',
            action: 'update',
            entityId: a.id,
            settings: '{"name":"Taken"}',
        }),
        { message: 'Colleague not found' },
    );
    t.deepEqual(
        await manageColleagues(store, { userId: 'user-b', action: 'list' }),
        { colleagues: [], total: 0, offset: 0, limit: 50, nextOffset: null },
    );
});

test('workspace bindings fail closed on ownership changes, chains, and archives', async (t) => {
    const { store, entities, resolvePersonal } = fixture();
    const a = await manageColleagues(
        store,
        { userId: 'user-a', action: 'create', settings: '{"name":"Noor"}' },
        resolvePersonal,
    );
    for (const badOwner of [
        { ...personal, personalOwnerId: 'user-b' },
        { ...personal, assocUserIds: ['user-a', 'user-b'] },
        { ...personal, kind: 'colleague' },
    ]) {
        entities.set(personal.id, badOwner);
        await t.throwsAsync(resolveColleagueWorkspace(a.id, store.getEntity), {
            message: 'Invalid shared workspace owner',
        });
    }
    entities.set(personal.id, personal);
    await manageColleagues(store, {
        userId: 'user-a',
        action: 'update',
        entityId: a.id,
        settings: '{"status":"archived"}',
    });
    await t.throwsAsync(resolveColleagueWorkspace(a.id, store.getEntity), {
        message: 'Colleague is archived',
    });
});

test('watch inputs cannot escape workspace or scan cloud mounts and shell text stays encoded', (t) => {
    for (const path of [
        '/workspace',
        '/workspace/',
        '/workspace/../etc',
        '/workspace/.env',
        '/workspace/files/inbox',
        '/cloud-files',
    ])
        t.throws(() => validateWatchPath(path));
    t.is(validateWatchPath('/workspace/inbox'), '/workspace/inbox');
    const command = watchCommand('/workspace/$(touch injected)');
    t.false(command.includes('$(touch'));
    t.true(command.startsWith("python3 -c '"));
});


test('recruitment retries use an owner-bound stable identity and preserve subsequent edits', async t => {
    const { store, resolvePersonal, entities } = fixture();
    const args = { userId: 'user-a', action: 'create', settings: JSON.stringify({ name: 'Developer', instructions: 'Build software', creationKey: 'team:one:developer' }) };
    const [a, b] = await Promise.all([manageColleagues(store, args, resolvePersonal), manageColleagues(store, args, resolvePersonal)]);
    t.is(a.id, b.id);
    t.is([...entities.values()].filter(e => e.kind === 'colleague').length, 1);
    await store.upsertEntity({ id: a.id, name: 'Renamed by owner', identity: 'New instructions' });
    const retried = await manageColleagues(store, args, resolvePersonal);
    t.is(retried.name, 'Renamed by owner');
    t.is(retried.instructions, 'New instructions');
    const other = await manageColleagues(store, { ...args, userId: 'user-b' }, async () => ({ entityId: 'personal-b' }));
    t.not(other.id, a.id);
});
