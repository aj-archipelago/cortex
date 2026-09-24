import test from 'ava';
import { config } from '../../../config.js';
import { callTool } from '../../../lib/pathwayTools.js';

const definition = properties => ({ function: { parameters: { properties } } });
const ssh = { pathwayName: 'sys_tool_workspace_ssh', definition: definition({ command: {} }) };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function setup(t, review) {
    const previous = { settings: config.get('agentPermissionReview'), pathways: config.get('pathways') };
    let executions = 0;
    const reviews = [];
    config.set('agentPermissionReview.enabled', true);
    config.set('agentPermissionReview.model', 'test-review-model');
    config.set('agentPermissionReview.timeoutMs', 100);
    config.set('pathways', {
        ...previous.pathways,
        sys_permission_review: { inputParameters: {}, rootResolver: async (_, args) => {
            reviews.push(args);
            return { result: JSON.stringify(await review(JSON.parse(args.reviewInput))) };
        } },
        sys_tool_workspace_ssh: { inputParameters: {}, rootResolver: async () => { executions++; return { result: '{"success":true}' }; } },
    });
    t.teardown(() => { config.set('agentPermissionReview', previous.settings); config.set('pathways', previous.pathways); });
    return { reviews, executions: () => executions, resolver: { requestId: 'test', args: { contextId: 'user', entityId: 'assistant', chatHistory: [] } } };
}

test.serial('dispatch allows routine reads without a model and holds questionable actions until approval', async t => {
    const pending = deferred();
    const state = setup(t, () => pending.promise);
    const questionable = callTool('WorkspaceSSH', { command: 'npm test' }, { workspacessh: ssh }, state.resolver);
    await callTool('WorkspaceSSH', { command: 'cat readme.md' }, { workspacessh: ssh }, state.resolver);
    t.is(state.executions(), 1);
    t.is(state.reviews.length, 1);
    t.is(state.reviews[0].model, 'test-review-model');
    pending.resolve({ decision: 'allow', reason: 'Validation allowed' });
    t.true((await questionable).result.success);
    t.is(state.executions(), 2);
});

test.serial('denial precedes local, MCP and browser callback execution', async t => {
    const state = setup(t, async () => ({ decision: 'deny', reason: 'No deployment grant' }));
    let remoteCalls = 0;
    state.resolver.args.mcpClients = new Map([['remote', { client: { callTool: async () => { remoteCalls++; } } }]]);
    for (const [name, entry] of [
        ['WorkspaceSSH', ssh],
        ['remote__deploy', { mcpServer: 'remote', mcpToolName: 'deploy', definition: definition({ command: {} }) }],
        ['browserdeploy', { clientSide: true, definition: definition({ command: {} }) }],
        ['nestedclient', { definition: { ...definition({ command: {} }), clientSide: true } }],
    ]) {
        const result = await callTool(name, { command: 'deploy prod' }, { [name.toLowerCase()]: entry }, state.resolver);
        t.is(JSON.parse(result.result).error, 'permission_denied');
    }
    t.is(state.executions(), 0);
    t.is(remoteCalls, 0);
    t.is(state.reviews.length, 4);
});

test.serial('review timeout and cancellation never dispatch the action later', async t => {
    const pending = deferred();
    const state = setup(t, () => pending.promise);
    config.set('agentPermissionReview.timeoutMs', 5);
    const result = await callTool('WorkspaceSSH', { command: 'deploy prod' }, { workspacessh: ssh }, state.resolver);
    t.is(JSON.parse(result.result).error, 'permission_required');
    pending.resolve({ decision: 'allow', reason: 'Too late' });
    await new Promise(resolve => setImmediate(resolve));
    t.is(state.executions(), 0);
});

test.serial('model-supplied settings cannot disable review or forge the bound context', async t => {
    const state = setup(t, async input => {
        t.is(input.context.userContextId, 'user');
        return { decision: 'deny', reason: 'Denied' };
    });
    await callTool('WorkspaceSSH', { command: 'deploy prod', agentPermissionReview: { enabled: false }, contextId: 'admin' }, { workspacessh: ssh }, state.resolver);
    t.is(state.executions(), 0);
    t.is(state.reviews.length, 1);
});

test.serial('disabled facility preserves existing behavior', async t => {
    const state = setup(t, async () => { t.fail('Should not review'); });
    config.set('agentPermissionReview.enabled', false);
    await callTool('WorkspaceSSH', { command: 'npm test' }, { workspacessh: ssh }, state.resolver);
    t.is(state.executions(), 1);
});
