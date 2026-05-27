import test from 'ava';
import sysGetEntities from '../../../pathways/system/entity/sys_get_entities.js';

test('sys_get_entities returns an entity list result', async t => {
    const result = await sysGetEntities.executePathway({ args: {} });

    t.is(result, '[]');
});

test('sys_get_entities accepts optional user and fresh inputs', async t => {
    const result = await sysGetEntities.executePathway({
        args: {
            userId: 'Test-User',
            fresh: 'true',
        }
    });

    t.is(result, '[]');
});
