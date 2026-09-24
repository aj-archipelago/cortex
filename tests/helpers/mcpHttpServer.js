import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

// A real HTTP/SSE peer for lifecycle tests; no provider credentials or model calls.
export async function createMcpHttpServer({ hangInitialize = false, hangListTools = false } = {}) {
    const streams = new Set();
    const requests = [];
    const sockets = new Set();
    let streamOpens = 0;
    let initializeClosed = false;
    const server = http.createServer(async (req, res) => {
        if (req.method === 'GET') {
            streamOpens++;
            streams.add(res);
            res.on('close', () => streams.delete(res));
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            res.write(': connected\n\n');
            return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const message = JSON.parse(Buffer.concat(chunks).toString());
        requests.push(message.method);
        if (message.method === 'initialize' && hangInitialize) {
            res.on('close', () => { initializeClosed = true; });
            return;
        }
        if (message.method === 'tools/list' && hangListTools) return;
        if (message.id === undefined) {
            res.writeHead(202).end();
            return;
        }
        const result = message.method === 'initialize'
            ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'lifecycle-fixture', version: '1' } }
            : message.method === 'tools/list'
                ? { tools: [{ name: 'ping', description: 'Local test tool', inputSchema: { type: 'object', properties: {} } }] }
                : { content: [{ type: 'text', text: 'pong' }] };
        res.writeHead(200, { 'Content-Type': 'application/json', 'mcp-session-id': 'local-test-session' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return {
        url: `http://127.0.0.1:${server.address().port}/mcp`,
        requests,
        get streamCount() { return streams.size; },
        get streamOpens() { return streamOpens; },
        get initializeClosed() { return initializeClosed; },
        async waitFor(predicate) {
            for (let i = 0; i < 100; i++) {
                if (predicate()) return true;
                await delay(10);
            }
            return false;
        },
        async close() {
            for (const socket of sockets) socket.destroy();
            await new Promise(resolve => server.close(resolve));
        },
    };
}
