import test from 'ava';
import { config } from '../../../config.js';
import { getEntityStore } from '../../../lib/MongoEntityStore.js';
import sysEntityUpdate from '../../../pathways/system/entity/sys_entity_update.js';
import sysEntityUpsertPersonal from '../../../pathways/system/entity/sys_entity_upsert_personal.js';
import storeSecret from '../../../pathways/system/entity/tools/sys_tool_store_secret.js';

const stubEntityStore = (overrides = {}) => {
    const entityStore = getEntityStore();
    const originals = {};
    for (const key of Object.keys(overrides)) {
        originals[key] = entityStore[key];
        entityStore[key] = overrides[key];
    }
    return () => {
        for (const [key, value] of Object.entries(originals)) {
            entityStore[key] = value;
        }
    };
};

const stubConfigGet = (handler) => {
    const originalGet = config.get;
    config.get = handler;
    return () => {
        config.get = originalGet;
    };
};

test.serial('sys_entity_update updates owned entity name, reasoning effort, and secrets', async t => {
    let persisted;
    const restore = stubEntityStore({
        getEntity: async () => ({
            id: 'entity-1',
            name: 'Jarvis',
            assocUserIds: ['user-1'],
            secrets: { OLD_TOKEN: 'keep', REMOVE_ME: 'delete' },
            workspace: { status: 'stopped' },
        }),
        upsertEntity: async (entity) => {
            persisted = entity;
            return entity.id;
        },
    });
    t.teardown(restore);

    const result = JSON.parse(await sysEntityUpdate.executePathway({
        args: {
            entityId: 'entity-1',
            contextId: 'user-1',
            name: 'Jarvis Prime',
            reasoningEffort: 'high',
            secrets: JSON.stringify({ API_TOKEN: 'new-value', REMOVE_ME: null }),
        },
    }));

    t.true(result.success);
    t.is(result.name, 'Jarvis Prime');
    t.is(result.reasoningEffort, 'high');
    t.deepEqual(result.secretKeys, ['OLD_TOKEN', 'API_TOKEN']);
    t.like(persisted, {
        name: 'Jarvis Prime',
        reasoningEffort: 'high',
    });
    t.deepEqual(persisted.secrets, {
        OLD_TOKEN: 'keep',
        API_TOKEN: 'new-value',
    });
});

test.serial('sys_entity_update rejects updates from non-associated users', async t => {
    const restore = stubEntityStore({
        getEntity: async () => ({
            id: 'entity-1',
            assocUserIds: ['owner-1'],
        }),
    });
    t.teardown(restore);

    const result = JSON.parse(await sysEntityUpdate.executePathway({
        args: {
            entityId: 'entity-1',
            contextId: 'other-user',
            name: 'Nope',
        },
    }));

    t.is(result.error, 'Not authorized to update this entity');
});

test.serial('sys_entity_upsert_personal creates a Jarvis personal entity by default', async t => {
    let capturedDefaults;
    const restore = stubEntityStore({
        isConfigured: () => true,
        getDefaultEntity: async () => null,
        findOrCreatePersonalEntity: async (userId, defaults) => {
            capturedDefaults = { userId, defaults };
            return { id: 'personal-1', name: defaults.name };
        },
    });
    t.teardown(restore);

    const result = JSON.parse(await sysEntityUpsertPersonal.executePathway({
        args: { userId: 'user-1' },
    }));

    t.deepEqual(result, { id: 'personal-1', name: 'Jarvis' });
    t.is(capturedDefaults.userId, 'user-1');
    t.deepEqual(capturedDefaults.defaults.assocUserIds, ['user-1']);
    t.is(capturedDefaults.defaults.name, 'Jarvis');
    t.deepEqual(capturedDefaults.defaults.tools, ['*']);
});

test.serial('StoreSecret stores a secret on the entity and annotates resolver tool usage', async t => {
    let persisted;
    const restoreConfig = stubConfigGet((key) => {
        if (key === 'redisEncryptionKey') return null;
        return undefined;
    });
    t.teardown(restoreConfig);

    const restoreEntityStore = stubEntityStore({
        getEntity: async () => ({
            id: 'entity-1',
            secrets: { EXISTING_TOKEN: 'old' },
            workspace: { status: 'stopped' },
        }),
        upsertEntity: async (entity) => {
            persisted = entity;
            return entity.id;
        },
    });
    t.teardown(restoreEntityStore);

    const resolver = {};
    const result = JSON.parse(await storeSecret.executePathway({
        args: {
            entityId: 'entity-1',
            name: 'API_TOKEN',
            value: 'secret-value',
        },
        resolver,
    }));

    t.true(result.success);
    t.deepEqual(result.secretKeys, ['EXISTING_TOKEN', 'API_TOKEN']);
    t.deepEqual(persisted.secrets, {
        EXISTING_TOKEN: 'old',
        API_TOKEN: 'secret-value',
    });
    t.deepEqual(JSON.parse(resolver.tool), {
        toolUsed: 'StoreSecret',
        action: 'store',
        name: 'API_TOKEN',
    });
});

test('StoreSecret tool definition is explicitly system-scoped', t => {
    const [definition] = storeSecret.toolDefinition;
    t.is(definition.category, 'system');
    t.is(definition.function.name, 'StoreSecret');
    t.true(definition.function.description.includes('/workspace/.env'));
    t.deepEqual(definition.function.parameters.required, ['name', 'userMessage']);
});
