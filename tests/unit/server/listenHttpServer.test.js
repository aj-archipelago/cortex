import test from 'ava';
import http from 'http';
import { WebSocketServer } from 'ws';
import { listenHttpServer } from '../../../lib/listenHttpServer.js';

const occupyPort = (port) => new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => res.end('ok'));
    server.once('error', reject);
    server.listen(port, () => resolve(server));
});

const closeServer = (server) => new Promise((resolve, reject) => {
    if (!server?.listening) return resolve();
    server.close((err) => (err ? reject(err) : resolve()));
});

test('listens on the preferred port when available', async (t) => {
    const blocker = await occupyPort(0);
    const preferredPort = blocker.address().port;
    await closeServer(blocker);

    const server = http.createServer();
    t.teardown(() => closeServer(server));

    const bound = await listenHttpServer(server, preferredPort, { allowFallback: false });
    t.is(bound, preferredPort);
    t.is(server.address().port, preferredPort);
});

test('falls back to the next free port when preferred is busy', async (t) => {
    const blocker = await occupyPort(0);
    const preferredPort = blocker.address().port;
    t.teardown(() => closeServer(blocker));

    const server = http.createServer();
    t.teardown(() => closeServer(server));

    const bound = await listenHttpServer(server, preferredPort, { allowFallback: true, maxAttempts: 10 });
    t.true(bound > preferredPort);
    t.is(server.address().port, bound);
});

test('throws EADDRINUSE when fallback is disabled', async (t) => {
    const blocker = await occupyPort(0);
    const preferredPort = blocker.address().port;
    t.teardown(() => closeServer(blocker));

    const server = http.createServer();
    t.teardown(() => closeServer(server));

    const err = await t.throwsAsync(() =>
        listenHttpServer(server, preferredPort, { allowFallback: false }),
    );
    t.is(err.code, 'EADDRINUSE');
});

test('fallback works with an attached WebSocketServer (graphql-ws once error)', async (t) => {
    // Reproduce the production crash path: ws forwards httpServer errors to
    // WebSocketServer, and graphql-ws only handles the first via once('error').
    const blockerA = await occupyPort(0);
    const preferredPort = blockerA.address().port;
    const blockerB = await occupyPort(preferredPort + 1);
    t.teardown(async () => {
        await closeServer(blockerA);
        await closeServer(blockerB);
    });

    const server = http.createServer();
    const wsServer = new WebSocketServer({ server, path: '/graphql' });
    // Mimic graphql-ws: only the first error is handled.
    wsServer.once('error', () => {});
    // Durable absorber used by Cortex after useServer().
    wsServer.on('error', () => {});
    t.teardown(async () => {
        wsServer.close();
        await closeServer(server);
    });

    const bound = await listenHttpServer(server, preferredPort, { allowFallback: true, maxAttempts: 10 });
    t.true(bound >= preferredPort + 2);
    t.is(server.address().port, bound);
});
