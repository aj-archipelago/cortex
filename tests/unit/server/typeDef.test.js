import test from 'ava';

import { getMessageTypeDefs, typeDef } from '../../../server/typeDef.js';

test('message type defs include file access and legacy agent context inputs', t => {
    const defs = getMessageTypeDefs();

    t.true(defs.includes('input AgentContextInput'));
    t.true(defs.includes('input FileAccessTargetInput'));
    t.true(defs.includes('workspaceId: String'));
    t.true(defs.includes('write: Boolean'));
});

test('pathway type defs support fileAccessPlan object arrays', t => {
    const built = typeDef({
        name: 'test_file_access',
        objName: 'test_file_access',
        inputParameters: {
            fileAccessPlan: {
                type: 'array',
                items: { objType: 'FileAccessTargetInput' },
                default: [],
            },
        },
    });

    t.true(built.gqlDefinition.includes('fileAccessPlan: [FileAccessTargetInput]'));
    t.deepEqual(built.restDefinition, [
        {
            name: 'fileAccessPlan',
            type: '[FileAccessTargetInput]',
        },
    ]);
});
