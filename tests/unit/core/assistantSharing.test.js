import test from 'ava';
import { manageColleagues, resolveColleagueWorkspace, publicColleague, assistantMaterialContext } from '../../../lib/colleagues.js';
import { canAccessEntity, entityMemoryContextId } from '../../../lib/entityPreferences.js';
import { withAssistantExecutionUser, assistantExecutionUser } from '../../../lib/assistantExecution.js';

const author = { id: 'personal-a', personalOwnerId: 'a', assocUserIds: ['a'] };
const recipient = { id: 'personal-b', personalOwnerId: 'b', assocUserIds: ['b'] };
const shared = { id: 'specialist', kind: 'colleague', colleagueOwnerId: 'a', assocUserIds: ['a'], workspaceOwnerId: author.id, assistantAccess: [{ userId: 'b', role: 'viewer' }], assistantMaterials: true };
const fixture = () => {
    const records = new Map([author, recipient, shared].map(e => [e.id, structuredClone(e)]));
    const store = { getEntity: async id => records.get(id), getAllEntities: async () => [...records.values()], upsertEntity: async entity => { records.set(entity.id, { ...records.get(entity.id), ...entity }); return entity.id; } };
    return { records, store };
};
test('one shared definition resolves to separate user workspaces and memories', async t => {
    const { store } = fixture();
    const resolvePersonal = async userId => ({ entityId: `personal-${userId}` });
    for (const userId of ['a', 'b']) {
        const binding = await resolveColleagueWorkspace(shared.id, store.getEntity, { userId, resolvePersonal });
        t.is(binding.entityId, `personal-${userId}`);
        t.is(publicColleague(shared, userId).agentContext, assistantMaterialContext(shared.id));
    }
    t.not(entityMemoryContextId(shared, 'a'), entityMemoryContextId(shared, 'b'));
    await t.throwsAsync(resolveColleagueWorkspace(shared.id, store.getEntity, { userId: 'outsider', resolvePersonal }));
    await t.throwsAsync(resolveColleagueWorkspace(shared.id, store.getEntity));
});
test('viewers cannot edit; coauthors can edit instructions but only owner controls sharing and lifecycle', async t => {
    const { store, records } = fixture();
    const update = (userId, input) => manageColleagues(store, { userId, action: 'update', entityId: shared.id, settings: JSON.stringify(input) });
    await t.throwsAsync(update('b', { instructions: 'change' }));
    await t.throwsAsync(update('b', { materialsEnabled: true }));
    await update('a', { access: [{ userId: 'b', role: 'editor' }] });
    await update('b', { instructions: 'Check evidence', materialsEnabled: true });
    t.is(records.get(shared.id).identity, 'Check evidence');
    await t.throwsAsync(update('b', { visibility: 'public' }));
    await t.throwsAsync(update('b', { status: 'archived' }));
    await update('a', { access: [] });
    t.false(canAccessEntity(records.get(shared.id), 'b'));
    await update('a', { visibility: 'public' });
    t.true(canAccessEntity(records.get(shared.id), 'b'));
    t.false(publicColleague(records.get(shared.id), 'b').editable);
});
test('parallel and nested execution retain the original user', async t => {
    const seen = await Promise.all(['a', 'b'].map(user => withAssistantExecutionUser(user, async () => {
        await new Promise(resolve => setImmediate(resolve));
        return withAssistantExecutionUser('forged', () => assistantExecutionUser());
    })));
    t.deepEqual(seen, ['a','b']);
    t.is(assistantExecutionUser(), null);
});

test('real entity persistence saves sharing and materials without resurrecting revoked access on a stale edit', async t => {
    const { MongoEntityStore } = await import('../../../lib/MongoEntityStore.js');
    const store = new MongoEntityStore();
    store.isConfigured = () => true;
    let persisted = { ...shared, assistantAccess: [] };
    store._getCollection = async () => ({
        findOne: async () => persisted,
        updateOne: async (_filter, update) => { persisted = { ...persisted, ...update.$set }; },
    });
    await store.upsertEntity({ id: shared.id, assistantVisibility: 'public', assistantAccess: [{userId:'b',role:'editor'}], assistantMaterials: true });
    t.is(persisted.assistantVisibility, 'public');
    t.deepEqual(persisted.assistantAccess, [{userId:'b',role:'editor'}]);
    t.true(persisted.assistantMaterials);
    // Another instance revokes access while this instance still has old data.
    persisted = { ...persisted, assistantVisibility: 'private', assistantAccess: [] };
    await store.upsertEntity({ id: shared.id, identity: 'Updated editorial guidance' });
    t.is(persisted.assistantVisibility, 'private');
    t.deepEqual(persisted.assistantAccess, []);
    t.true(persisted.assistantMaterials);
});
