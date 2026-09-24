import test from 'ava';
import sinon from 'sinon';
import { initializeMcpClients, closeMcpClients, createMcpToolDiscovery, callMcpTool } from '../../../lib/mcpClient.js';
import { createMcpHttpServer } from '../../helpers/mcpHttpServer.js';

test.serial('deferred MCP discovery contacts only the selected server once per request', async (t) => {
    const selected = await createMcpHttpServer();
    const unused = await createMcpHttpServer({ hangInitialize: true });
    const config = JSON.stringify({ selected: { url: selected.url }, unused: { url: unused.url } });
    const first = createMcpToolDiscovery(config);
    const second = createMcpToolDiscovery(config);
    t.teardown(async () => {
        await closeMcpClients(first.clients);
        await closeMcpClients(second.clients);
        await selected.close();
        await unused.close();
    });
    t.deepEqual(first.serverKeys, ['selected', 'unused']);
    t.deepEqual(selected.requests, []);
    const [a, b] = await Promise.all([first.discover('selected'), first.discover('selected')]);
    t.is(a, b);
    t.is(selected.requests.filter(method => method === 'initialize').length, 1);
    t.is(selected.requests.filter(method => method === 'tools/list').length, 1);
    t.truthy(a.entityTools.selected__ping);
    t.is((await callMcpTool(first.clients, 'selected__ping', {})).result, 'pong');
    await first.discover('selected');
    t.is(selected.requests.filter(method => method === 'tools/list').length, 1);
    await second.discover('selected');
    t.not(first.clients.get('selected'), second.clients.get('selected'), 'credentials and clients stay request-local');
    t.is(selected.requests.filter(method => method === 'initialize').length, 2);
    t.deepEqual(unused.requests, []);
});

test('deferred MCP discovery rejects unconfigured and expired services without connecting', async (t) => {
    const state = createMcpToolDiscovery(JSON.stringify({
        expired: { url: 'http://127.0.0.1:1/mcp', expiresAt: Date.now() - 1000 },
        unsupported: { url: 'http://127.0.0.1:1/mcp', type: 'stdio' },
    }));
    t.deepEqual(state.serverKeys, []);
    t.deepEqual(state.expiredServers, ['expired']);
    for (const key of ['expired', 'unsupported', 'constructor', 'https://unapproved.invalid']) {
        await t.throwsAsync(state.discover(key), { message: 'Select a configured MCP server to search.' });
    }
    for (const config of ['not-json', 'null', '[]']) t.deepEqual(createMcpToolDiscovery(config).serverKeys, []);
});

test.serial('failed deferred discovery is not retried on every tool search', async (t) => {
    const peer = await createMcpHttpServer({ hangInitialize: true });
    const state = createMcpToolDiscovery(JSON.stringify({ local: { url: peer.url } }));
    const realSetTimeout = globalThis.setTimeout;
    const timers = sinon.stub(globalThis, 'setTimeout').callsFake((callback, ms, ...args) =>
        realSetTimeout(callback, ms === 30000 ? 200 : ms, ...args));
    t.teardown(async () => {
        timers.restore();
        await closeMcpClients(state.clients);
        await peer.close();
    });
    await t.throwsAsync(state.discover('local'), { message: /unavailable/ });
    await t.throwsAsync(state.discover('local'), { message: /unavailable/ });
    t.is(peer.requests.filter(method => method === 'initialize').length, 1);
    t.true(await peer.waitFor(() => peer.initializeClosed));
    t.is(state.clients.size, 0);
});

test.serial('deferred discovery bounds a hung tool list and keeps cleanup ownership', async (t) => {
    const peer = await createMcpHttpServer({ hangListTools: true });
    const state = createMcpToolDiscovery(JSON.stringify({ local: { url: peer.url } }));
    const realSetTimeout = globalThis.setTimeout;
    const timers = sinon.stub(globalThis, 'setTimeout').callsFake((callback, ms, ...args) =>
        realSetTimeout(callback, ms === 15000 ? 200 : ms, ...args));
    t.teardown(async () => {
        timers.restore();
        await closeMcpClients(state.clients);
        await peer.close();
    });
    await t.throwsAsync(state.discover('local'), { message: /no available tools/ });
    await t.throwsAsync(state.discover('local'), { message: /no available tools/ });
    t.is(peer.requests.filter(method => method === 'tools/list').length, 1);
    t.is(state.clients.size, 1);
    await closeMcpClients(state.clients);
    t.true(await peer.waitFor(() => peer.streamCount === 0));
});

test.serial('MCP connect clears its deadline after successful initialization', async (t) => {
    const peer = await createMcpHttpServer();
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let deadline;
    const timers = sinon.stub(globalThis, 'setTimeout').callsFake((callback, ms, ...args) => {
        const timer = realSetTimeout(callback, ms, ...args);
        if (ms === 30000) deadline = timer;
        return timer;
    });
    const clears = sinon.spy(globalThis, 'clearTimeout');
    let clients = new Map();
    t.teardown(async () => {
        timers.restore();
        clears.restore();
        realClearTimeout(deadline);
        await closeMcpClients(clients);
        await peer.close();
    });
    ({ clients } = await initializeMcpClients(JSON.stringify({ local: { url: peer.url } })));
    t.is(clients.size, 1);
    t.truthy(deadline);
    t.true(clears.calledWith(deadline), 'completed initialization must clear its deadline');
});

test.serial('MCP connect deadline aborts an outstanding initialization request', async (t) => {
    const peer = await createMcpHttpServer({ hangInitialize: true });
    const realSetTimeout = globalThis.setTimeout;
    // Shorten only our connection deadline; leave HTTP and SDK timers real.
    const timers = sinon.stub(globalThis, 'setTimeout').callsFake((callback, ms, ...args) =>
        realSetTimeout(callback, ms === 30000 ? 2000 : ms, ...args));
    t.teardown(async () => {
        timers.restore();
        await peer.close();
    });
    const { clients } = await initializeMcpClients(JSON.stringify({ local: { url: peer.url } }));
    t.is(clients.size, 0);
    t.true(peer.requests.includes('initialize'));
    t.true(await peer.waitFor(() => peer.initializeClosed), 'timed-out initialization must abort the HTTP request');
});
