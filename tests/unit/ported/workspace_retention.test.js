import test from 'ava';
import { withWorkspaceRetention, workspaceRetentionRules, retentionMatches } from '../../../scripts/workspace-checkpoint-retention.mjs';

test('checkpoint retention preserves existing rules and scopes candidate deletion to tagged objects', t => {
    const existing = { name: 'existing', enabled: true, definition: { filters: { prefixMatch: ['other/'] }, actions: {} } };
    const policy = withWorkspaceRetention({ rules: [existing] }, 'example-workspaces');
    t.deepEqual(policy.rules[0], existing);
    t.true(retentionMatches(policy, 'example-workspaces'));
    const [history, candidates] = policy.rules.slice(1);
    t.falsy(history.definition.actions.baseBlob);
    t.deepEqual(candidates.definition.filters.blobIndexMatch, [{ name: 'workspaceCheckpoint', op: '==', value: 'candidate' }]);
    t.deepEqual(candidates.definition.filters.prefixMatch, ['example-workspaces/workspace-checkpoints/']);
    t.deepEqual(withWorkspaceRetention(policy, 'example-workspaces'), policy);
    t.false(retentionMatches({ rules: [existing] }, 'example-workspaces'));
    t.throws(() => workspaceRetentionRules('../invalid'), { message: /valid Azure container/ });
});
