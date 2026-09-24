import http from 'http';
import {
    checkReplayStoreHealth,
    closeReplayStore,
    getRealtimeGatewaySettings,
    parseRequestPathname,
    registerRealtimeAudioGateway,
} from './broker.js';

const port = Number(process.env.PORT || 7071);

const gateway = registerRealtimeAudioGateway({
    env: process.env,
    logger: console,
});

const server = http.createServer(async (req, res) => {
    const pathname = parseRequestPathname(req.url);
    if (!pathname) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('Bad request');
        return;
    }
    if (pathname === '/health') {
        const settings = getRealtimeGatewaySettings({ env: process.env });
        const capabilities = Object.fromEntries(
            Object.entries(settings.capabilities).map(([name, value]) => [
                name,
                value.available,
            ]),
        );
        const replayStoreAvailable = await checkReplayStoreHealth({
            env: process.env,
            logger: console,
        });
        const healthy =
            settings.authenticationAvailable &&
            Object.values(capabilities).some(Boolean) &&
            replayStoreAvailable;
        res.writeHead(healthy ? 200 : 503, {
            'content-type': 'application/json',
        });
        res.end(
            JSON.stringify({
                status: healthy ? 'healthy' : 'unhealthy',
                capabilities,
                authenticationAvailable: settings.authenticationAvailable,
                replayStoreAvailable,
            }),
        );
        return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
});
const httpSockets = new Set();
server.on('connection', (socket) => {
    httpSockets.add(socket);
    socket.on('close', () => httpSockets.delete(socket));
});

server.on('upgrade', (request, socket, head) => {
    const pathname = parseRequestPathname(request.url);
    if (!pathname || !gateway.realtimeAudioPaths.has(pathname)) {
        socket.destroy();
        return;
    }

    gateway.handleUpgrade(request, socket, head, (webSocket) => {
        gateway.emit('connection', webSocket, request);
    });
});

server.listen(port, '0.0.0.0', () => {
    console.log(`Cortex realtime gateway listening on ${port}`);
});

let shuttingDown = false;
function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    gateway.realtimeAudioShuttingDown = true;
    closeReplayStore();
    server.close();
    for (const client of gateway.clients) {
        client.close(1001, 'Server shutting down');
    }
    const forceCloseTimer = setTimeout(() => {
        for (const client of gateway.clients) client.terminate();
        for (const upstream of gateway.realtimeAudioUpstreamSockets) {
            upstream.terminate();
        }
        for (const socket of httpSockets) socket.destroy();
        closeReplayStore();
    }, 5000);
    forceCloseTimer.unref();
    gateway.close();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
