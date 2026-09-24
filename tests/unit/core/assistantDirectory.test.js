import test from 'ava';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { findAssistantPage, directoryOptions } from '../../../lib/assistantDirectory.js';
import { migrateAssistantDirectory } from '../../../lib/assistantDirectoryMigration.js';
import { manageColleagues, assistantMaterialContext } from '../../../lib/colleagues.js';
import { MongoEntityStore } from '../../../lib/MongoEntityStore.js';
import { preferenceId, canAccessEntity } from '../../../lib/entityPreferences.js';

let server, client, collection, store, records;
test.before(async () => {
    server = await MongoMemoryServer.create();
    client = await MongoClient.connect(server.getUri());
    collection = client.db('directory_test').collection('entities');
    records = Array.from({ length: 10000 }, (_, i) => ({
        id: `assistant-${i}`, name: `Specialist ${String(i).padStart(5, '0')}`,
        description: i % 7 === 0 ? 'Research and fact checking' : 'Editing',
        kind: 'colleague', colleagueOwnerId: i % 2 ? 'other' : 'reader',
        assocUserIds: [i % 2 ? 'other' : 'reader'],
        assistantVisibility: i % 3 ? 'private' : 'public',
        assistantAccess: i % 5 ? [] : [{ userId: 'reader', role: 'viewer' }],
        colleagueStatus: i % 11 ? 'active' : 'archived',
        identity: 'Secret instructions '.repeat(600), secrets: { SECRET: 'never project' },
        workspace: { private: true }, tools: ['*'], assistantMaterials: true,
    }));
    await collection.insertMany(records);
    await collection.insertMany([
        { id: 'malformed', name: 'A malformed assistant', kind: 'colleague', colleagueOwnerId: 'reader', assocUserIds: ['other'], assistantVisibility: 'public' },
        { id: 'unavailable', name: 'A missing deployment', assocUserIds: [], requiredEnvVars: ['ASSISTANT_DIRECTORY_TEST_MISSING_ENV_742'] },
        { id: 'system', name: 'A system assistant', isSystem: true, assocUserIds: [] },
        { id: 'literal', name: 'Research [a.*]', assocUserIds: [] },
    ]);
    store = new MongoEntityStore();
    store.isConfigured = () => true;
    store._getCollection = async () => collection;
    store.entityPreferences = async () => client.db('directory_test').collection('preferences');
});
test.after.always(async () => { await client?.close(); await server?.stop(); });

test('10,000 definitions use bounded pages, exact permissions and lightweight projections', async t => {
    const expected = records.filter(r => canAccessEntity(r, 'reader') && r.colleagueStatus !== 'archived').length + 1;
    const page = await findAssistantPage(store, 'reader');
    t.is(page.total, expected);
    t.is(page.entities.length, 50);
    t.is(page.nextOffset, 50);
    t.true(Buffer.byteLength(JSON.stringify(page)) < 60000);
    for (const row of page.entities) {
        t.true(canAccessEntity(row, 'reader'));
        for (const field of ['identity', 'secrets', 'workspace', 'tools']) t.false(Object.hasOwn(row, field));
    }
    const next = await findAssistantPage(store, 'reader', { offset: page.nextOffset });
    t.false(next.entities.some(r => page.entities.some(first => first.id === r.id)));
    t.is((await findAssistantPage(store, 'reader', { limit: 10000 })).entities.length, 100);
});
test('search is literal, filters run before pagination, and exact IDs can sit beyond page one', async t => {
    t.deepEqual((await findAssistantPage(store, 'reader', { query: '[a.*]' })).entities.map(r => r.id), ['literal']);
    const filtered = await findAssistantPage(store, 'reader', { query: 'fact checking', access: 'mine', status: 'active', descending: true });
    t.true(filtered.entities.every(r => r.description.includes('fact checking') && r.colleagueOwnerId === 'reader' && r.colleagueStatus === 'active'));
    t.true(filtered.entities[0].name > filtered.entities[1].name);
    t.deepEqual((await findAssistantPage(store, 'reader', { ids: ['assistant-9998'], status: 'all' })).entities.map(r => r.id), ['assistant-9998']);
    t.is((await findAssistantPage(store, 'outsider', { ids: ['assistant-9998'] })).total, 0);
    t.throws(() => directoryOptions({ ids: Array(101).fill('a') }));
});
test('a page batches preferences once; authorizing one assistant never lists the directory', async t => {
    const preferences = await store.entityPreferences();
    await preferences.insertOne({ _id: preferenceId('assistant-9998', 'reader'), model: 'preferred' });
    let reads = 0;
    const pageStore = { ...store, _getCollection: () => collection, entityPreferences: async () => ({ find: query => { reads++; return preferences.find(query); } }) };
    const page = await manageColleagues(pageStore, { userId: 'reader', settings: JSON.stringify({ ids: ['assistant-9998'], status: 'all' }) });
    t.is(reads, 1);
    t.is(page.colleagues[0].model, 'preferred');
    t.false(Object.hasOwn(page.colleagues[0], 'instructions'));
    let lookups = 0;
    const direct = { getEntity: async (id, options) => { lookups++; t.true(options.fresh); return collection.findOne({id}); } };
    const result = await manageColleagues(direct, { userId: 'reader', action: 'get', entityId: 'assistant-9998' });
    t.is(lookups, 1);
    t.true(result.instructions.length > 10000);
    await t.throwsAsync(manageColleagues(direct, { userId: 'outsider', action: 'get', entityId: 'assistant-9998' }), { message: 'Colleague not found' });
});
test.serial('derived material lookups migrate in batches and can be rerun', async t => {
    const first = await migrateAssistantDirectory(collection);
    t.is(first.updated, 10001);
    t.is((await migrateAssistantDirectory(collection)).updated, 0);
    const indexes = await collection.listIndexes().toArray();
    t.true(indexes.some(index => index.key.assistantMaterialsContext));
    const plan = await collection.find({ id: 'assistant-9998' }).explain('executionStats');
    t.is(plan.executionStats.totalDocsExamined, 1);
    const page = await findAssistantPage(store, 'reader', { materialsContext: assistantMaterialContext('assistant-9998'), status: 'all' });
    t.deepEqual(page.entities.map(r => r.id), ['assistant-9998']);
    t.is((await findAssistantPage(store, 'outsider', { materialsContext: assistantMaterialContext('assistant-9998') })).total, 0);
});
test('entity cache stays bounded and an evicted definition remains accessible', async t => {
    const cached = new MongoEntityStore();
    cached.isConfigured = () => true;
    cached._getCollection = () => collection;
    for (let i = 0; i < 700; i++) await cached.getEntity(`assistant-${i}`);
    t.is(cached._entityCache.size, 512);
    t.is(cached._cacheTimestamps.size, 512);
    t.false(cached._entityCache.has('assistant-0'));
    t.is((await cached.getEntity('assistant-0')).id, 'assistant-0');
});
