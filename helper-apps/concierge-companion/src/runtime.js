import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import WebSocket from 'ws';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function localHost(hostname) {
    let host = hostname.toLowerCase();
    const mapped = host.match(/^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/);
    if (mapped) {
        const high = parseInt(mapped[1], 16),
            low = parseInt(mapped[2], 16);
        host = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
    }
    return {
        host,
        local:
            host === 'localhost' ||
            host.endsWith('.localhost') ||
            host.endsWith('.local') ||
            (!host.includes('.') && !host.includes(':')) ||
            host === '[::1]' ||
            /^\[f[cd][0-9a-f]{2}:/.test(host) ||
            /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(
                host,
            ),
    };
}

export function connectorUrl(value) {
    const url = new URL(value);
    const { host, local } = localHost(url.hostname);
    if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash ||
        /^169\.254\./.test(host) ||
        host === '0.0.0.0' ||
        host === '[::]' ||
        host.startsWith('[fe80:') ||
        (url.protocol === 'http:' && !local)
    )
        throw new Error(
            'Use HTTPS for internet servers or a local network address',
        );
    if (host === 'localhost') url.hostname = '127.0.0.1';
    return url;
}

export function validateServers(servers) {
    if (!Array.isArray(servers) || servers.length > 30)
        throw new Error('Choose up to 30 connectors');
    const ids = new Set();
    return servers.map((server) => {
        if (!/^[a-zA-Z0-9_-]{1,80}$/.test(server.id) || ids.has(server.id))
            throw new Error('Each server needs a unique ID');
        ids.add(server.id);
        if (typeof server.name !== 'string' || !server.name.trim())
            throw new Error('Server name is required');
        if (server.type === 'files') {
            if (
                !Array.isArray(server.folders) ||
                !server.folders.length ||
                server.folders.length > 20 ||
                server.folders.some(
                    (p) => typeof p !== 'string' || !path.isAbsolute(p),
                )
            )
                throw new Error('Choose folders on this computer');
            return {
                id: server.id,
                name: server.name.slice(0, 100),
                type: 'files',
                folders: server.folders,
            };
        }
        if (server.type === 'stdio') {
            if (
                !path.isAbsolute(server.command || '') ||
                !Array.isArray(server.args || []) ||
                (server.args || []).some((a) => typeof a !== 'string')
            )
                throw new Error(
                    'Use an absolute executable path and an argument array',
                );
            if (
                server.env &&
                (typeof server.env !== 'object' ||
                    Array.isArray(server.env) ||
                    Object.values(server.env).some(
                        (v) => typeof v !== 'string',
                    ))
            )
                throw new Error('Environment values must be strings');
            return {
                id: server.id,
                name: server.name.slice(0, 100),
                type: 'stdio',
                command: server.command,
                args: server.args || [],
                env: server.env || {},
            };
        }
        if (!['streamable-http', 'sse'].includes(server.type))
            throw new Error('Choose HTTP, SSE, or stdio');
        const url = connectorUrl(server.url);
        if (
            server.headers &&
            (typeof server.headers !== 'object' ||
                Array.isArray(server.headers) ||
                Object.values(server.headers).some(
                    (v) => typeof v !== 'string',
                ))
        )
            throw new Error('Headers must be strings');
        return {
            id: server.id,
            name: server.name.slice(0, 100),
            type: server.type,
            url: url.href,
            headers: server.headers || {},
        };
    });
}

export function serviceOrigin(value, development = false) {
    const url = new URL(value);
    if (
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
    )
        throw new Error('Enter a service origin without a path');
    if (
        url.protocol !== 'https:' &&
        !(
            development &&
            url.protocol === 'http:' &&
            ['127.0.0.1', 'localhost'].includes(url.hostname)
        )
    )
        throw new Error('Use an HTTPS service address');
    return url.origin;
}

export function createLocalExecutor(input) {
    const servers = new Map(validateServers(input).map((s) => [s.id, s]));
    const clients = new Map();
    const transports = new Set();
    let stopped = false;
    async function connect(id) {
        const config = servers.get(id);
        if (!config || stopped) throw new Error('Local server is not enabled');
        if (!clients.has(id)) {
            const promise = (async () => {
                const client = new Client({
                    name: 'concierge-companion',
                    version: '0.1.0',
                });
                const localFetch = (url, options) => {
                    const target = new URL(url);
                    if (target.origin !== new URL(config.url).origin)
                        throw new Error(
                            'MCP server attempted to leave its configured origin',
                        );
                    return fetch(url, { ...options, redirect: 'error' });
                };
                const transport =
                    config.type === 'files'
                        ? new StdioClientTransport({
                              command: process.execPath,
                              args: [
                                  fileURLToPath(
                                      import.meta.resolve(
                                          '@modelcontextprotocol/server-filesystem/dist/index.js',
                                      ),
                                  ),
                                  ...config.folders,
                              ],
                              env: { ELECTRON_RUN_AS_NODE: '1' },
                              stderr: 'ignore',
                          })
                        : config.type === 'stdio'
                          ? new StdioClientTransport({
                                command: config.command,
                                args: config.args,
                                env: config.env,
                                stderr: 'ignore',
                            })
                          : config.type === 'sse'
                            ? new SSEClientTransport(new URL(config.url), {
                                  requestInit: { headers: config.headers },
                                  fetch: localFetch,
                              })
                            : new StreamableHTTPClientTransport(
                                  new URL(config.url),
                                  {
                                      requestInit: { headers: config.headers },
                                      fetch: localFetch,
                                  },
                              );
                transports.add(transport);
                const timeout = setTimeout(
                    () => transport.close().catch(() => {}),
                    15000,
                );
                try {
                    await client.connect(transport, { timeout: 15000 });
                    if (stopped) {
                        await transport.close();
                        throw new Error('Companion stopped');
                    }
                    return client;
                } catch (error) {
                    clients.delete(id);
                    transports.delete(transport);
                    await transport.close().catch(() => {});
                    throw error;
                } finally {
                    clearTimeout(timeout);
                }
            })();
            clients.set(id, promise);
        }
        return clients.get(id);
    }
    return {
        manifest: [...servers.values()].map((s) => ({
            id: s.id,
            name: s.name,
        })),
        async execute({ method, serverId, params, deadline }) {
            if (!['tools/list', 'tools/call'].includes(method))
                throw new Error('Unsupported local method');
            const remaining = Math.min(120000, Number(deadline) - Date.now());
            if (!Number.isFinite(remaining) || remaining <= 0)
                throw new Error('Local request expired');
            const client = await connect(serverId);
            const timeout = Math.min(remaining, Number(deadline) - Date.now());
            if (timeout <= 0) throw new Error('Local request expired');
            if (method === 'tools/list')
                return client.listTools(params, { timeout });
            if (typeof params?.name !== 'string')
                throw new Error('Tool name is required');
            return client.callTool(params, undefined, { timeout });
        },
        async close() {
            stopped = true;
            await Promise.allSettled([...transports].map((t) => t.close()));
            clients.clear();
        },
    };
}

// Reconnect only the transport. A dispatched tool is never replayed.
export function startCompanion({
    relayUrl,
    token,
    servers,
    onStatus = () => {},
}) {
    const executor = createLocalExecutor(servers);
    let stopped = false;
    let socket;
    let timer;
    let attempt = 0;
    const seen = new Set();
    const active = new Set();
    function connect() {
        if (stopped) return;
        onStatus('connecting');
        const url = new URL('/v1/connect', relayUrl);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(url, {
            headers: { Authorization: `Bearer ${token}` },
            maxPayload: 4 * 1024 * 1024,
            handshakeTimeout: 10000,
            followRedirects: false,
        });
        socket = ws;
        let watchdog;
        const receivedHeartbeat = () => {
            clearTimeout(watchdog);
            watchdog = setTimeout(() => ws.terminate(), 45000);
        };
        ws.on('ping', receivedHeartbeat);
        ws.on('open', () => {
            receivedHeartbeat();
            ws.send(
                JSON.stringify({ type: 'hello', servers: executor.manifest }),
            );
        });
        ws.on('message', async (raw) => {
            let message;
            try {
                message = JSON.parse(raw);
            } catch {
                ws.close(4002);
                return;
            }
            if (message.type === 'ready') {
                attempt = 0;
                onStatus('connected');
                return;
            }
            if (typeof message.id !== 'string' || seen.has(message.id)) return;
            seen.add(message.id);
            if (seen.size > 10000) seen.delete(seen.values().next().value);
            let result;
            let error;
            try {
                if (active.size >= 8) throw new Error('Computer is busy');
                active.add(message.id);
                result = await executor.execute(message);
            } catch (e) {
                error = e.message || 'Local tool failed';
            } finally {
                active.delete(message.id);
            }
            if (ws.readyState === WebSocket.OPEN) {
                const payload = JSON.stringify({
                    id: message.id,
                    result,
                    error,
                });
                ws.send(
                    Buffer.byteLength(payload) <= 4 * 1024 * 1024
                        ? payload
                        : JSON.stringify({
                              id: message.id,
                              error: 'Tool result exceeds 4 MiB; save the output as a file instead',
                          }),
                );
            }
        });
        ws.on('error', () => {});
        ws.on('unexpected-response', (_req, response) => {
            response.resume();
            if ([401, 403].includes(response.statusCode)) {
                stopped = true;
                onStatus('unpaired');
                executor.close();
            }
            ws.terminate();
        });
        ws.on('close', (code) => {
            clearTimeout(watchdog);
            if (code === 4000) {
                stopped = true;
                onStatus('paused');
                executor.close();
            }
            if (code === 4001) {
                stopped = true;
                onStatus('unpaired');
                executor.close();
            }
            if (stopped) return;
            onStatus('offline');
            timer = setTimeout(
                connect,
                Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)) +
                    Math.random() * 1000,
            );
        });
    }
    connect();
    return {
        isBusy: () => active.size > 0,
        async stop() {
            stopped = true;
            clearTimeout(timer);
            socket?.terminate();
            await executor.close();
            onStatus('paused');
        },
    };
}
