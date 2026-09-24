import test from 'ava';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';
import Redis from 'ioredis';
import WebSocket from 'ws';
import { createRelay } from '../../../helper-apps/cortex-companion-relay/relay.js';
import {
    startCompanion,
    createLocalExecutor,
    validateServers,
    serviceOrigin,
} from '../../../helper-apps/concierge-companion/src/runtime.js';
import {
    createMcpToolDiscovery,
    closeMcpClients,
    callMcpTool,
    discoverMcpTools,
} from '../../../lib/mcpClient.js';
import { createMcpHttpServer } from '../../helpers/mcpHttpServer.js';
import {
    parseHandoff,
    inspectHandoff,
    pairedConfiguration,
} from '../../../helper-apps/concierge-companion/src/pairing.js';
import { startUpdates } from '../../../helper-apps/concierge-companion/src/updates.js';

const adminKey = 'test-only-companion-admin-key-1234567890+/=';
async function until(predicate) {
    for (let i = 0; i < 150; i++) {
        if (await predicate()) return;
        await delay(20);
    }
    throw new Error('Condition not reached');
}
async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${server.address().port}`;
}
async function setup(t) {
    const directory = await mkdtemp(path.join(tmpdir(), 'companion-test-'));
    const socket = path.join(directory, 'redis.sock');
    const process = spawn(
        'redis-server',
        [
            '--port',
            '0',
            '--unixsocket',
            socket,
            '--save',
            '',
            '--appendonly',
            'no',
        ],
        { stdio: 'ignore' },
    );
    process.on('error', () => {});
    const redis = new Redis({
        path: socket,
        maxRetriesPerRequest: 1,
        retryStrategy: () => 20,
    });
    redis.on('error', () => {});
    await until(async () => {
        try {
            return await redis.ping();
        } catch {
            return false;
        }
    });
    const first = await createRelay({ redis, adminKey, rpcTimeout: 2000 });
    const second = await createRelay({ redis, adminKey, rpcTimeout: 2000 });
    const url = await listen(first.server);
    const otherUrl = await listen(second.server);
    const helpers = [];
    t.teardown(async () => {
        for (const helper of helpers) await helper.stop();
        await first.close();
        await second.close();
        await redis.quit();
        const exited = new Promise((resolve) => process.once('exit', resolve));
        process.kill('SIGTERM');
        await exited;
        await rm(directory, { recursive: true, force: true });
    });
    async function request(endpoint, body, token = adminKey, origin = url) {
        const res = await fetch(`${origin}${endpoint}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        return { status: res.status, data: await res.json() };
    }
    return { request, url, otherUrl, helpers, redis };
}

test.serial(
    'real MCP round trip across relay replicas, ownership, replay and revocation',
    async (t) => {
        const { request, url, otherUrl, helpers } = await setup(t);
        const mcp = await createMcpHttpServer();
        t.teardown(() => mcp.close());
        const { data: pair } = await request(
            '/v1/pair/start',
            { name: 'Edit Mac' },
            '',
        );
        t.is(
            (
                await fetch(`${url}/v1/pair/status`, {
                    headers: { Authorization: `Bearer ${pair.token}` },
                })
            ).status,
            202,
        );
        t.is(
            (
                await request('/v1/admin/pair', {
                    owner: 'account:alice',
                    code: pair.code,
                })
            ).status,
            200,
        );
        t.is(
            (
                await request('/v1/admin/pair', {
                    owner: 'account:bob',
                    code: pair.code,
                })
            ).status,
            404,
        );
        t.is(
            (
                await request(
                    '/v1/admin/devices',
                    { owner: 'account:alice' },
                    'wrong-key',
                )
            ).status,
            401,
        );
        t.deepEqual(
            (await request('/v1/admin/devices', { owner: 'account:bob' })).data
                .devices,
            [],
        );
        const browserSocket = new WebSocket(
            url.replace('http:', 'ws:') + '/v1/connect',
            {
                origin: 'https://evil.example',
                headers: { Authorization: `Bearer ${pair.token}` },
            },
        );
        const rejected = new Promise((resolve) =>
            browserSocket.once('unexpected-response', (_req, res) => {
                res.resume();
                resolve(res.statusCode);
                browserSocket.terminate();
            }),
        );
        browserSocket.on('error', () => {});
        t.is(await rejected, 401);
        let status;
        const companion = startCompanion({
            relayUrl: url,
            token: pair.token,
            servers: [
                {
                    id: 'premiere',
                    name: 'Premiere',
                    type: 'streamable-http',
                    url: mcp.url,
                    headers: { Authorization: 'Bearer local-only-secret' },
                },
            ],
            onStatus: (value) => {
                status = value;
            },
        });
        helpers.push(companion);
        await until(() => status === 'connected');
        const devices = (
            await request(
                '/v1/admin/devices',
                { owner: 'account:alice' },
                adminKey,
                otherUrl,
            )
        ).data.devices;
        t.true(devices[0].online);
        t.false(JSON.stringify(devices).includes('local-only-secret'));
        t.deepEqual(devices[0].servers, [{ id: 'premiere', name: 'Premiere' }]);
        const { config } = (
            await request(
                '/v1/admin/config',
                { owner: 'account:alice' },
                adminKey,
                otherUrl,
            )
        ).data;
        const serverKey = Object.keys(config)[0];
        const grant = config[serverKey];
        t.is(
            (
                await request(
                    '/v1/rpc',
                    { ...grant, method: 'tools/list', serverId: 'unapproved' },
                    grant.token,
                )
            ).status,
            403,
        );
        t.is(
            (
                await request(
                    '/v1/rpc',
                    { ...grant, method: 'shell/exec' },
                    grant.token,
                )
            ).status,
            400,
        );
        const previous = process.env.CORTEX_COMPANION_RELAY_URL;
        process.env.CORTEX_COMPANION_RELAY_URL = otherUrl;
        t.teardown(() => {
            if (previous === undefined)
                delete process.env.CORTEX_COMPANION_RELAY_URL;
            else process.env.CORTEX_COMPANION_RELAY_URL = previous;
        });
        const discovery = createMcpToolDiscovery(JSON.stringify(config));
        t.deepEqual(discovery.serverKeys, [serverKey]);
        t.is(discovery.serverLabels[serverKey], 'Premiere (Edit Mac)');
        const tools = await discovery.discover(serverKey);
        t.truthy(tools.mcpToolCatalog[`${serverKey}__ping`]);
        const result = await callMcpTool(
            discovery.clients,
            `${serverKey}__ping`,
            {},
            'ping',
        );
        t.true(JSON.stringify(result).includes('pong'));
        t.is(mcp.requests.filter((m) => m === 'tools/call').length, 1);
        await closeMcpClients(discovery.clients);
        t.is(
            (
                await request('/v1/admin/revoke', {
                    owner: 'account:bob',
                    deviceId: pair.deviceId,
                })
            ).status,
            404,
        );
        t.is(
            (
                await request(
                    '/v1/admin/revoke',
                    { owner: 'account:alice', deviceId: pair.deviceId },
                    adminKey,
                    otherUrl,
                )
            ).status,
            200,
        );
        await until(() => status === 'unpaired');
        t.is(
            (
                await request(
                    '/v1/rpc',
                    { ...grant, method: 'tools/list' },
                    grant.token,
                )
            ).status,
            403,
        );
        t.is(
            (
                await fetch(`${url}/v1/pair/status`, {
                    headers: { Authorization: `Bearer ${pair.token}` },
                })
            ).status,
            401,
        );
        t.is(mcp.requests.filter((m) => m === 'tools/call').length, 1);
    },
);

test.serial(
    'connection loss reports an uncertain result and never replays an edit',
    async (t) => {
        const { request, url, helpers } = await setup(t);
        const { data: pair } = await request(
            '/v1/pair/start',
            { name: 'Editor' },
            '',
        );
        await request('/v1/admin/pair', { owner: 'alice', code: pair.code });
        let calls = 0;
        const ws = new WebSocket(url.replace('http:', 'ws:') + '/v1/connect', {
            headers: { Authorization: `Bearer ${pair.token}` },
        });
        helpers.push({ stop: async () => ws.terminate() });
        await new Promise((resolve) => {
            ws.once('open', resolve);
        });
        ws.send(
            JSON.stringify({
                type: 'hello',
                servers: [{ id: 'editor', name: 'Editor' }],
            }),
        );
        await new Promise((resolve) => ws.once('message', resolve));
        const grant = Object.values(
            (await request('/v1/admin/config', { owner: 'alice' })).data.config,
        )[0];
        ws.on('message', (raw) => {
            if (JSON.parse(raw).method === 'tools/call') {
                calls++;
                ws.terminate();
            }
        });
        const result = await request(
            '/v1/rpc',
            { ...grant, method: 'tools/call', params: { name: 'edit' } },
            grant.token,
        );
        t.is(result.status, 502);
        t.regex(result.data.error, /may have run/);
        await delay(100);
        t.is(calls, 1);
        t.is(
            (
                await request(
                    '/v1/rpc',
                    { ...grant, method: 'tools/list' },
                    grant.token,
                )
            ).status,
            409,
        );
    },
);

test('explicit network connectors allow HTTPS and private HTTP but reject unsafe targets', (t) => {
    for (const url of [
        'http://example.com/mcp',
        'http://169.254.169.254/mcp',
        'file:///tmp/mcp',
        'http://user:secret@localhost/mcp',
        'https://example.com/#secret',
        'http://[::ffff:a9fe:a9fe]/mcp',
    ]) {
        t.throws(() =>
            validateServers([
                { id: 'test', name: 'Test', type: 'streamable-http', url },
            ]),
        );
    }
    t.throws(() =>
        validateServers([
            { id: 'test', name: 'Test', type: 'stdio', command: 'npx' },
        ]),
    );
    t.throws(() => serviceOrigin('http://example.com'));
    t.throws(() => serviceOrigin('https://example.com/path'));
    t.is(
        validateServers([
            {
                id: 'test',
                name: 'Test',
                type: 'streamable-http',
                url: 'http://localhost:123/mcp',
            },
        ])[0].url,
        'http://127.0.0.1:123/mcp',
    );
    for (const url of [
        'https://example.com/mcp',
        'http://10.1.2.3/mcp',
        'http://editor.local/mcp',
        'http://[fd00::1]/mcp',
        'http://[::ffff:7f00:1]/mcp',
    ])
        t.is(
            validateServers([
                { id: 'test', name: 'Test', type: 'streamable-http', url },
            ])[0].type,
            'streamable-http',
        );
});

test.serial(
    'browser handoffs are encrypted, expire, cannot be replayed and preserve account boundaries',
    async (t) => {
        const { request, redis, url, otherUrl, helpers } = await setup(t);
        const site = 'https://concierge.example';
        const intent = {
            kind: 'server',
            name: 'Editor',
            url: 'http://localhost:3001/mcp',
            token: 'local-secret',
            command: '/bin/sh',
        };
        const { data: setupLink } = await request('/v1/admin/handoff', {
            owner: 'alice',
            site,
            account: 'Alice',
            intent,
        });
        const data = { ticket: setupLink.ticket, site };
        const ticketKey = `companion:handoff:${createHash('sha256').update(setupLink.ticket).digest('hex')}`;
        const stored = await redis.get(ticketKey);
        t.false(stored.includes('local-secret'));
        t.false(stored.includes('Alice'));
        t.is(
            (
                await request(
                    '/v1/handoff/inspect',
                    { ...data, site: 'https://other.example' },
                    '',
                )
            ).status,
            403,
        );
        const inspected = await request(
            '/v1/handoff/inspect',
            data,
            '',
            otherUrl,
        );
        t.is(inspected.data.account, 'Alice');
        t.is(inspected.data.intent.command, undefined);
        t.deepEqual(
            (await request('/v1/admin/devices', { owner: 'alice' })).data
                .devices,
            [],
        );
        const browser = await fetch(`${url}/v1/handoff/claim`, {
            method: 'POST',
            headers: { Origin: site, 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
        t.is(browser.status, 403);
        const concurrent = await Promise.all([
            request('/v1/handoff/claim', { ...data, name: 'My Mac' }, ''),
            request('/v1/handoff/claim', data, '', otherUrl),
        ]);
        t.deepEqual(concurrent.map((r) => r.status).sort(), [200, 410]);
        const paired = concurrent.find((r) => r.status === 200).data;
        let connection;
        helpers.push(
            startCompanion({
                relayUrl: url,
                token: paired.token,
                servers: [],
                onStatus: (value) => {
                    connection = value;
                },
            }),
        );
        await until(() => connection === 'connected');
        t.false(
            (
                await request('/v1/admin/handoff-status', {
                    owner: 'alice',
                    ticket: setupLink.ticket,
                })
            ).data.paired,
        );
        t.is(
            (
                await request(
                    '/v1/handoff/complete',
                    { ticket: setupLink.ticket },
                    paired.token,
                )
            ).status,
            200,
        );
        t.true(
            (
                await request(
                    '/v1/admin/handoff-status',
                    { owner: 'alice', ticket: setupLink.ticket },
                    adminKey,
                    otherUrl,
                )
            ).data.paired,
        );
        t.false(
            (
                await request('/v1/admin/handoff-status', {
                    owner: 'bob',
                    ticket: setupLink.ticket,
                })
            ).data.paired,
        );
        t.is((await request('/v1/handoff/inspect', data, '')).status, 410);
        const fresh = await request('/v1/admin/handoff', {
            owner: 'alice',
            site,
        });
        const reused = await request(
            '/v1/handoff/claim',
            { site, ticket: fresh.data.ticket },
            paired.token,
        );
        t.true(reused.data.reused);
        t.is(reused.data.deviceId, paired.deviceId);
        t.is(
            (await request('/v1/admin/devices', { owner: 'alice' })).data
                .devices.length,
            1,
        );
        const other = await request('/v1/admin/handoff', {
            owner: 'bob',
            site,
        });
        const isolated = await request(
            '/v1/handoff/claim',
            { site, ticket: other.data.ticket },
            paired.token,
        );
        t.false(isolated.data.reused);
        t.not(isolated.data.deviceId, paired.deviceId);
        t.deepEqual(
            (await request('/v1/admin/devices', { owner: 'bob' })).data
                .devices[0].servers,
            [],
        );
        const expired = await request('/v1/admin/handoff', {
            owner: 'alice',
            site,
        });
        await redis.pexpire(
            `companion:handoff:${createHash('sha256').update(expired.data.ticket).digest('hex')}`,
            1,
        );
        await delay(5);
        t.is(
            (
                await request(
                    '/v1/handoff/claim',
                    { site, ticket: expired.data.ticket },
                    '',
                )
            ).status,
            410,
        );
    },
);

test('native deep links accept only an origin and opaque ticket; approval does not happen during inspection', async (t) => {
    const ticket = 'a'.repeat(43);
    const link = `concierge-companion://connect?site=https%3A%2F%2Fconcierge.example&ticket=${ticket}`;
    t.deepEqual(parseHandoff(link), {
        conciergeUrl: 'https://concierge.example',
        ticket,
    });
    for (const invalid of [
        link + '&command=sh',
        link + '&ticket=bad',
        link + '#x',
        link.replace('connect?', 'exec?'),
        link.replace('https%3A', 'http%3A'),
        link.replace('connect?', 'user@connect?'),
    ])
        t.throws(() => parseHandoff(invalid));
    const calls = [];
    const request = async (origin, endpoint) => {
        calls.push([origin, endpoint]);
        return {
            data:
                endpoint === '/api/companion/config'
                    ? { enabled: true, relayUrl: 'https://relay.example' }
                    : {
                          site: 'https://concierge.example',
                          account: 'Alice',
                          intent: { kind: 'files' },
                      },
        };
    };
    const pending = await inspectHandoff(link, { request });
    t.is(pending.kind, 'files');
    t.deepEqual(
        calls.map((c) => c[1]),
        ['/api/companion/config', '/v1/handoff/inspect'],
    );
});

test('a new site cannot inherit enabled tools even if its relay claims reuse', (t) => {
    const previous = {
        conciergeUrl: 'https://concierge.example',
        relayUrl: 'https://relay.example',
        servers: [
            {
                id: 'files',
                name: 'Files',
                type: 'files',
                folders: ['/private/projects'],
            },
        ],
    };
    const response = {
        token: 'a'.repeat(43),
        deviceId: 'computer',
        reused: true,
    };
    const otherSite = {
        conciergeUrl: 'https://other.example',
        relayUrl: 'https://other-relay.example',
    };
    t.deepEqual(pairedConfiguration(previous, otherSite, response).servers, []);
    t.deepEqual(
        pairedConfiguration(previous, previous, response).servers,
        previous.servers,
    );
    t.deepEqual(
        pairedConfiguration(previous, previous, { ...response, reused: false })
            .servers,
        [],
    );
});

test('bundled files connector reads chosen folders and rejects paths and symlinks outside them', async (t) => {
    const folder = await mkdtemp(path.join(tmpdir(), 'companion-files-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'companion-outside-'));
    t.teardown(() =>
        Promise.all([
            rm(folder, { recursive: true, force: true }),
            rm(outside, { recursive: true, force: true }),
        ]),
    );
    await writeFile(path.join(folder, 'test.txt'), 'chosen file');
    await writeFile(path.join(outside, 'private.txt'), 'not authorized');
    await symlink(outside, path.join(folder, 'escape'));
    const executor = createLocalExecutor([
        { id: 'files', name: 'Files', type: 'files', folders: [folder] },
    ]);
    t.teardown(() => executor.close());
    const call = (p) =>
        executor.execute({
            serverId: 'files',
            method: 'tools/call',
            params: { name: 'read_text_file', arguments: { path: p } },
            deadline: Date.now() + 10000,
        });
    t.is(
        (await call(path.join(folder, 'test.txt'))).content[0].text,
        'chosen file',
    );
    for (const target of [
        path.join(outside, 'private.txt'),
        path.join(folder, 'escape/private.txt'),
    ]) {
        const result = await call(target);
        t.true(result.isError);
        t.false(JSON.stringify(result).includes('not authorized'));
    }
});

test('updates are disabled for internal builds and never restart an active tool', async (t) => {
    const updater = new EventEmitter();
    let prepared = false;
    let checks = 0,
        installs = 0,
        busy = true;
    updater.checkForUpdates = async () => {
        checks++;
    };
    updater.quitAndInstall = () => {
        t.true(prepared);
        installs++;
    };
    const states = [];
    startUpdates({ updater, enabled: false, onStatus: (s) => states.push(s) });
    t.is(checks, 0);
    const updates = startUpdates({
        updater,
        enabled: true,
        isBusy: () => busy,
        beforeInstall: async () => {
            prepared = true;
        },
        onStatus: (s) => states.push(s),
    });
    t.teardown(() => updates.stop());
    t.is(checks, 1);
    t.true(updater.autoDownload);
    t.false(updater.allowDowngrade);
    updater.emit('update-downloaded');
    t.true(updater.autoInstallOnAppQuit);
    t.false(await updates.install());
    t.is(installs, 0);
    busy = false;
    t.true(await updates.install());
    t.is(installs, 1);
});

test('stdio server starts only from locally configured executable and returns its tool result', async (t) => {
    const fixture = fileURLToPath(
        new URL('../../fixtures/companion-stdio.mjs', import.meta.url),
    );
    const executor = createLocalExecutor([
        {
            id: 'editor',
            name: 'Editor',
            type: 'stdio',
            command: process.execPath,
            args: [fixture],
        },
    ]);
    t.teardown(() => executor.close());
    const result = await executor.execute({
        method: 'tools/call',
        serverId: 'editor',
        params: { name: 'ping', arguments: {} },
        deadline: Date.now() + 5000,
    });
    t.is(result.content[0].text, 'stdio pong');
    await t.throwsAsync(() =>
        executor.execute({
            method: 'shell/exec',
            serverId: 'editor',
            deadline: Date.now() + 5000,
        }),
    );
    await t.throwsAsync(() =>
        executor.execute({
            method: 'tools/call',
            serverId: 'other',
            deadline: Date.now() + 5000,
        }),
    );
});

test('local HTTP redirects cannot move tool calls or credentials to another host', async (t) => {
    const server = http.createServer((_req, res) =>
        res.writeHead(307, { Location: 'http://example.com/mcp' }).end(),
    );
    const url = await listen(server);
    t.teardown(() => {
        server.closeAllConnections();
        server.close();
    });
    const executor = createLocalExecutor([
        { id: 'test', name: 'Test', type: 'streamable-http', url },
    ]);
    t.teardown(() => executor.close());
    await t.throwsAsync(() =>
        executor.execute({
            method: 'tools/list',
            serverId: 'test',
            deadline: Date.now() + 3000,
        }),
    );
});

test('legacy local SSE transports initialize and return a tool result', async (t) => {
    let stream;
    const connections = new Set();
    const server = http.createServer(async (req, res) => {
        if (req.method === 'GET') {
            stream = res;
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(
                'event: endpoint\ndata: /messages?sessionId=local-test\n\n',
            );
            return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const message = JSON.parse(Buffer.concat(chunks).toString());
        res.writeHead(202).end();
        if (message.id === undefined) return;
        const result =
            message.method === 'initialize'
                ? {
                      protocolVersion: message.params.protocolVersion,
                      capabilities: { tools: {} },
                      serverInfo: { name: 'sse-test', version: '1' },
                  }
                : { content: [{ type: 'text', text: 'SSE pong' }] };
        stream.write(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`,
        );
    });
    server.on('connection', (socket) => {
        connections.add(socket);
        socket.on('close', () => connections.delete(socket));
    });
    const url = await listen(server);
    const executor = createLocalExecutor([
        { id: 'test', name: 'Test', type: 'sse', url: `${url}/sse` },
    ]);
    t.teardown(async () => {
        await executor.close();
        for (const socket of connections) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
    });
    const result = await executor.execute({
        method: 'tools/call',
        serverId: 'test',
        params: { name: 'ping' },
        deadline: Date.now() + 5000,
    });
    t.is(result.content[0].text, 'SSE pong');
});

test('long case-sensitive local tool names fit the model limit and invoke the original name', async (t) => {
    const originalName =
        'ReadPremiereTimelineWithAVeryLongCaseSensitiveNameForTheLocalTool';
    let called;
    const clients = new Map([
        [
            'local-0123456789ab',
            {
                localCompanion: true,
                connectTimestamp: Date.now(),
                client: {
                    listTools: async () => ({
                        tools: [
                            {
                                name: originalName,
                                inputSchema: { type: 'object', properties: {} },
                            },
                        ],
                    }),
                    callTool: async (params) => {
                        called = params.name;
                        return {
                            content: [{ type: 'text', text: 'timeline' }],
                        };
                    },
                },
            },
        ],
    ]);
    const discovered = await discoverMcpTools(clients);
    const key = Object.keys(discovered.entityTools)[0];
    t.true(key.length <= 64);
    await callMcpTool(
        clients,
        key,
        {},
        discovered.entityTools[key].mcpToolName,
    );
    t.is(called, originalName);
});
