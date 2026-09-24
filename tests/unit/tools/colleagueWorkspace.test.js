import { resolveExplicitEntityConfig } from '../../../pathways/system/entity/tools/shared/sys_entity_tools.js';
import test from 'ava';
import { config } from '../../../config.js';
import { getEntityStore } from '../../../lib/MongoEntityStore.js';
import { colleagueDirectory } from '../../../lib/colleagues.js';
import notifyUser from '../../../pathways/system/entity/tools/sys_tool_notify_user.js';

let workspace;
test.before(async () => {
    const original = global.setTimeout;
    global.setTimeout = () => ({ unref() {} });
    try {
        workspace = await import(
            '../../../pathways/system/entity/tools/shared/workspace_client.js'
        );
    } finally {
        global.setTimeout = original;
    }
});

function fixture(t) {
    const store = getEntityStore();
    const previous = {
        getEntity: store.getEntity,
        isConfigured: store.isConfigured,
        upsertEntity: store.upsertEntity,
        colleagueOutbox: store.colleagueOutbox,
        fetch: global.fetch,
        configGet: config.get,
    };
    const owner = {
        id: 'personal',
        personalOwnerId: 'user',
        assocUserIds: ['user'],
        workspace: {
            status: 'running',
            url: 'http://shared.test:3100',
            secret: 'owner-secret',
        },
    };
    const colleague = (id) => ({
        id,
        name: id,
        kind: 'colleague',
        colleagueOwnerId: 'user',
        colleagueStatus: 'active',
        workspaceOwnerId: 'personal',
        assocUserIds: ['user'],
    });
    const entities = new Map([
        ['personal', owner],
        ['first', colleague('first')],
        ['second', colleague('second')],
    ]);
    store.getEntity = async (id) => entities.get(id);
    store.isConfigured = () => true;
    store.upsertEntity = async () => {
        t.fail(
            'Using an existing shared workspace must not provision or copy runtime state',
        );
    };
    config.get = (key) =>
        key === 'workspaceImageVersion'
            ? null
            : previous.configGet.call(config, key);
    const requests = [];
    global.fetch = async (url, options) => {
        requests.push({ url, ...options });
        return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, stdout: 'ok' }),
        };
    };
    workspace.__testables.setActivityRedisClientForTest(null);
    t.teardown(() => {
        store.getEntity = previous.getEntity;
        store.isConfigured = previous.isConfigured;
        store.upsertEntity = previous.upsertEntity;
        store.colleagueOutbox = previous.colleagueOutbox;
        global.fetch = previous.fetch;
        config.get = previous.configGet;
        workspace.__testables.resetActivityStateForTest();
    });
    return { store, requests, entities };
}

test.serial(
    'two colleagues execute in their own directories on the owner container and share activity',
    async (t) => {
        const { requests } = fixture(t);
        for (const id of ['first', 'second']) {
            const result = await workspace.workspaceRequest(id, '/shell', {
                command: 'pwd',
            });
            t.true(result.success);
        }
        t.is(requests.length, 2);
        t.true(
            requests.every(
                (r) =>
                    r.url === 'http://shared.test:3100/shell' &&
                    r.headers['x-workspace-secret'] === 'owner-secret',
            ),
        );
        t.true(
            JSON.parse(requests[0].body).command.includes(
                colleagueDirectory('first'),
            ),
        );
        t.true(
            JSON.parse(requests[1].body).command.includes(
                colleagueDirectory('second'),
            ),
        );
        t.true(workspace.__testables.lastActivity.has('personal'));
        t.false(workspace.__testables.lastActivity.has('first'));
        t.false(workspace.__testables.lastActivity.has('second'));
    },
);

test.serial(
    'colleagues cannot reset or destroy the shared runtime through lifecycle commands',
    async (t) => {
        const { requests, entities } = fixture(t);
        t.false(
            (await workspace.workspaceRequest('first', '/reset', {})).success,
        );
        t.false(
            (await workspace.destroyWorkspace('first', entities.get('first')))
                .success,
        );
        t.false(
            (await workspace.stopWorkspace('first', entities.get('first')))
                .success,
        );
        t.is(requests.length, 0);
    },
);

test.serial(
    'notification tools persist help for the verified owner and reject foreign contexts',
    async (t) => {
        const { store } = fixture(t);
        const messages = [];
        store.colleagueOutbox = async () => ({
            insertOne: async (message) => messages.push(message),
        });
        const args = {
            entityId: 'first',
            contextId: 'chat-context',
            fileAccessPlan: [{ userContextId: 'user' }],
            message: 'Which source should I use?',
            kind: 'help',
        };
        t.true(JSON.parse(await notifyUser.executePathway({ args })).success);
        t.is(messages[0].owner, 'user');
        t.is(messages[0].entityId, 'first');
        t.is(messages[0].kind, 'help');
        const forbidden = JSON.parse(
            await notifyUser.executePathway({
                args: { ...args, fileAccessPlan: [{ userContextId: 'other' }] },
            }),
        );
        t.truthy(forbidden.error);
        t.is(messages.length, 1);
    },
);

test.serial(
    'missing and foreign colleague targets fail without personal-entity repair',
    async (t) => {
        fixture(t);
        const missing = await resolveExplicitEntityConfig('colleague-missing', {
            userId: 'user',
        });
        t.true(missing.disabled);
        t.false(missing.repaired);
        const foreign = await resolveExplicitEntityConfig('first', {
            userId: 'foreign',
        });
        t.true(foreign.disabled);
        t.false(foreign.repaired);
    },
);

test.serial('personal assistants notify only their current owner', async (t) => {
    const { store } = fixture(t);
    const messages = [];
    store.colleagueOutbox = async () => ({ insertOne: async message => messages.push(message) });
    const args = {
        entityId: 'personal',
        contextId: 'run-context',
        fileAccessPlan: [{ userContextId: 'user' }],
        message: 'Your result is ready.',
        kind: 'result',
    };
    t.true(JSON.parse(await notifyUser.executePathway({ args })).success);
    t.is(messages[0].owner, 'user');
    t.is(messages[0].entityId, 'personal');
    t.truthy(JSON.parse(await notifyUser.executePathway({ args: {
        ...args, fileAccessPlan: [{ userContextId: 'foreign' }],
    } })).error);
    t.is(messages.length, 1);
});

test.serial('shared specialists route each message to the calling user without broadcasting', async (t) => {
    const { store, entities } = fixture(t);
    entities.set('shared', {
        id: 'shared', name: 'Shared specialist', assocUserIds: ['user', 'second-user'],
        createdBy: 'entity-author',
    });
    const messages = [];
    store.colleagueOutbox = async () => ({ insertOne: async message => messages.push(message) });
    for (const user of ['user', 'second-user']) {
        const result = await notifyUser.executePathway({ args: {
            entityId: 'shared',
            contextId: 'run-context',
            fileAccessPlan: [{ userContextId: user }],
            owner: 'entity-author', recipient: 'someone-else',
            message: 'Which source should I use?', kind: 'help',
        } });
        t.true(JSON.parse(result).success);
    }
    t.deepEqual(messages.map(message => message.owner), ['user', 'second-user']);
    t.true(messages.every(message => message.entityId === 'shared' && message.kind === 'help'));
    t.truthy(JSON.parse(await notifyUser.executePathway({ args: {
        entityId: 'shared', fileAccessPlan: [{ userContextId: 'foreign' }],
        message: 'Not allowed', kind: 'result',
    } })).error);
    t.is(messages.length, 2);
});

test.serial('public catalog entities still require a user and reject unavailable entities', async (t) => {
    const { store, entities } = fixture(t);
    entities.set('catalog', { id: 'catalog', name: 'Catalog specialist' });
    entities.set('system', { id: 'system', isSystem: true });
    entities.set('archived', { ...entities.get('first'), id: 'archived', colleagueStatus: 'archived' });
    const messages = [];
    store.colleagueOutbox = async () => ({ insertOne: async message => messages.push(message) });
    const args = { entityId: 'catalog', message: 'Ready.', kind: 'result' };
    t.truthy(JSON.parse(await notifyUser.executePathway({ args })).error);
    t.true(JSON.parse(await notifyUser.executePathway({ args: {
        ...args, fileAccessPlan: [{ userContextId: 'user' }],
    } })).success);
    for (const entityId of ['system', 'archived', 'missing']) {
        t.truthy(JSON.parse(await notifyUser.executePathway({ args: {
            ...args, entityId, fileAccessPlan: [{ userContextId: 'user' }],
        } })).error);
    }
    t.is(messages.length, 1);
});

test.serial('Concierge notifications wait for durable delivery through the bound capability', async (t) => {
    const { store, requests } = fixture(t);
    const previousEndpoint = process.env.CONCIERGE_AGENT_TOOLS_URL;
    process.env.CONCIERGE_AGENT_TOOLS_URL = 'http://localhost:3002/api/agent-tools';
    t.teardown(() => {
        if (previousEndpoint === undefined) delete process.env.CONCIERGE_AGENT_TOOLS_URL;
        else process.env.CONCIERGE_AGENT_TOOLS_URL = previousEndpoint;
    });
    store.colleagueOutbox = async () => { t.fail('Direct delivery must not enqueue a duplicate'); };
    const args = {
        entityId: 'personal', fileAccessPlan: [{ userContextId: 'user' }],
        contextId: 'run-context', message: 'Ready.', kind: 'result',
        agentToolsToken: 'bound-token', _toolRequestId: 'request', _parentToolCallId: 'call',
        url: '/automations/task/runs/result',
        endpoint: 'http://untrusted.test', owner: 'someone-else',
    };
    t.true(JSON.parse(await notifyUser.executePathway({ args })).success);
    t.is(requests[0].url, process.env.CONCIERGE_AGENT_TOOLS_URL);
    t.is(requests[0].redirect, 'error');
    t.is(requests[0].headers.Authorization, 'Bearer bound-token');
    t.deepEqual(JSON.parse(requests[0].body), {
        tool: 'notifyuser', args: { message: 'Ready.', kind: 'result', url: '/automations/task/runs/result' },
        entityId: 'personal', contextId: 'user', callId: 'request:call',
    });
    global.fetch = async () => ({ ok: false, json: async () => ({ error: 'Expired capability' }) });
    t.deepEqual(JSON.parse(await notifyUser.executePathway({ args })), { error: 'Expired capability' });
    global.fetch = async () => { throw new Error('Connection lost after delivery'); };
    await t.throwsAsync(() => notifyUser.executePathway({ args }), { message: 'Connection lost after delivery' });
    for (const url of ['javascript:alert(1)', '//evil.test', '/\\evil.test', 'https://user:password@example.com', 'https://example.com/\nreport']) {
        t.deepEqual(JSON.parse(await notifyUser.executePathway({ args: { ...args, url } })), { error: 'Invalid message' });
    }
});
