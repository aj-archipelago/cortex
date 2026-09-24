import test from 'ava';
import management from '../../../pathways/system/entity/tools/sys_tool_colleague_management.js';
import { COLLEAGUE_AGENT_TOOL_NAMES } from '../../../lib/colleagueAgentTools.js';
import { getAlwaysVisibleLocalToolDefinitions } from '../../../pathways/system/entity/tools/shared/sys_entity_tools.js';

test('colleague management tools are first-class without browser callbacks', (t) => {
    const tools = Object.fromEntries(
        management.toolDefinition.map((definition) => [
            definition.function.name.toLowerCase(),
            { definition, pathwayName: 'sys_tool_colleague_management' },
        ]),
    );
    t.is(getAlwaysVisibleLocalToolDefinitions(tools).length, management.toolDefinition.length);
    t.true(COLLEAGUE_AGENT_TOOL_NAMES.has('createautomation'));
});
test.serial(
    'management sends only explicit tool parameters and a bound identity to the configured endpoint',
    async (t) => {
        const oldFetch = globalThis.fetch,
            oldEndpoint = process.env.CONCIERGE_AGENT_TOOLS_URL;
        process.env.CONCIERGE_AGENT_TOOLS_URL =
            'http://localhost:3002/api/agent-tools';
        let seen;
        globalThis.fetch = async (url, options) => {
            seen = { url, ...options, body: JSON.parse(options.body) };
            return { ok: true, json: async () => ({ name: 'New name' }) };
        };
        try {
            await management.executePathway({
                args: {
                    toolFunction: 'updatecolleaguesettings',
                    entityId: 'rowan',
                    contextId: 'run-context',
                    fileAccessPlan: [{ userContextId: 'owner' }],
                    agentToolsToken: 'bound-token',
                    model: 'inherited-model',
                    reasoningEffort: 'high',
                    _toolRequestId: 'request',
                    _parentToolCallId: 'call',
                    _colleagueToolParameters: {
                        name: 'New name',
                        entityId: 'other',
                        endpoint: 'http://evil.test',
                    },
                },
            });
            t.is(seen.url, process.env.CONCIERGE_AGENT_TOOLS_URL);
            t.deepEqual(seen.body.args, { name: 'New name' });
            t.is(seen.body.entityId, 'rowan');
            t.is(seen.body.contextId, 'owner');
            t.is(seen.headers.Authorization, 'Bearer bound-token');
            t.is(seen.redirect, 'error');
            await management.executePathway({
                args: {
                    toolFunction: 'answertaskquestion',
                    entityId: 'rowan',
                    contextId: 'owner',
                    agentToolsToken: 'bound-token',
                    _colleagueToolParameters: {
                        questionId: 'pending-question',
                        answer: 'Show the reviewed result; do not rebuild it.',
                        chatId: 'unrelated-chat',
                    },
                },
            });
            t.deepEqual(seen.body.args, {
                questionId: 'pending-question',
                answer: 'Show the reviewed result; do not rebuild it.',
            });
            await management.executePathway({ args: {
                toolFunction: 'updateassistantteam', entityId: 'rowan', contextId: 'owner', agentToolsToken: 'bound-token',
                _colleagueToolParameters: { teamId: 'paused-team', revision: 3, currentStep: 'Reviewing the final draft', owner: 'someone-else' },
            } });
            t.deepEqual(seen.body.args, { teamId: 'paused-team', revision: 3, currentStep: 'Reviewing the final draft' });
            const finish = {
                teamId: 'paused-team', summary: 'Delivered here', artifacts: [], evidence: ['Observed delivery'], reviewTaskIds: ['review'],
                questionAnswers: [{ questionId: 'question', answer: 'Opened the reviewed result here' }],
            };
            await management.executePathway({ args: {
                toolFunction: 'finishassistantteam', entityId: 'rowan', contextId: 'owner', agentToolsToken: 'bound-token',
                _colleagueToolParameters: { ...finish, chatId: 'unrelated-chat', owner: 'someone-else' },
            } });
            t.deepEqual(seen.body.args, finish);
        } finally {
            globalThis.fetch = oldFetch;
            if (oldEndpoint === undefined)
                delete process.env.CONCIERGE_AGENT_TOOLS_URL;
            else process.env.CONCIERGE_AGENT_TOOLS_URL = oldEndpoint;
        }
    },
);
