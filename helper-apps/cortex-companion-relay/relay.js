import http from 'node:http';
import {
    randomBytes,
    randomUUID,
    createHash,
    timingSafeEqual,
} from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { handoffCodec, setupIntent } from './handoff.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const MAX_BYTES = 4 * 1024 * 1024;
const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });
const json = (res, status, value) => {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(value));
};
async function body(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) throw fail(413, 'Request too large');
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString() || '{}');
    } catch {
        throw fail(400, 'Invalid JSON');
    }
}
const bearer = (req) =>
    /^Bearer ([^\s]+)$/.exec(req.headers.authorization || '')?.[1] || '';
const equal = (a, b) =>
    timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));

// Redis owns authorization and presence. Pub/sub routes to the replica holding
// the outbound device socket; no load-balancer affinity is required.
export async function createRelay({
    redis,
    adminKey,
    namespace = 'companion',
    rpcTimeout = 120000,
}) {
    if (!adminKey || adminKey.length < 32)
        throw new Error(
            'A dedicated admin key of at least 32 characters is required',
        );
    if (!/^[a-z0-9_-]+$/i.test(namespace))
        throw new Error('Invalid Redis namespace');
    const key = (suffix) => `${namespace}:${suffix}`;
    const instance = randomUUID();
    const channel = key(`instance:${instance}`);
    const subscriber = redis.duplicate();
    const sockets = new Map();
    const pending = new Map();
    const get = async (name) =>
        JSON.parse((await redis.get(key(name))) || 'null');
    const ownerKey = (owner) => key(`owner:${hash(owner)}`);
    const codec = handoffCodec(adminKey);
    const requireOwner = (owner) => {
        if (typeof owner !== 'string' || !owner || owner.length > 300)
            throw fail(400, 'Invalid owner');
        return owner;
    };
    async function deviceAuth(token) {
        if (!token) throw fail(401, 'Device authorization required');
        const id = await redis.get(key(`token:${hash(token)}`));
        const device = id && (await get(`device:${id}`));
        if (!device || device.revoked) throw fail(401, 'Device disconnected');
        return device;
    }
    async function rateLimit(bucket, maximum, seconds) {
        const count = await redis.eval(
            "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",
            1,
            key(`rate:${bucket}`),
            seconds,
        );
        if (count > maximum) throw fail(429, 'Please try again later');
    }
    async function listDevices(owner) {
        const ids = await redis.smembers(ownerKey(owner));
        const records = await Promise.all(ids.map((id) => get(`device:${id}`)));
        return Promise.all(
            records
                .filter((d) => d && !d.revoked)
                .map(async (d) => ({
                    id: d.id,
                    name: d.name,
                    servers: d.servers || [],
                    online: Boolean(
                        await redis.exists(key(`presence:${d.id}`)),
                    ),
                })),
        );
    }
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BYTES });
    async function publishReply(message, data) {
        await redis.publish(
            message.replyTo,
            JSON.stringify({ kind: 'reply', id: message.id, ...data }),
        );
    }
    subscriber.on('message', async (_channel, raw) => {
        try {
            const message = JSON.parse(raw);
            if (message.kind === 'reply') {
                const request = pending.get(message.id);
                if (request) {
                    pending.delete(message.id);
                    clearTimeout(request.timer);
                    request.resolve(message);
                }
            } else if (message.kind === 'revoke') {
                sockets.get(message.deviceId)?.ws.close(4001, 'Disconnected');
            } else if (message.kind === 'request') {
                const socket = sockets.get(message.deviceId);
                const device = await get(`device:${message.deviceId}`);
                if (
                    !device ||
                    device.revoked ||
                    !socket ||
                    socket.connectionId !== message.connectionId ||
                    socket.ws.readyState !== WebSocket.OPEN
                ) {
                    await publishReply(message, {
                        error: 'Computer is offline. No tool was dispatched.',
                    });
                    return;
                }
                if (socket.requests.size >= 16) {
                    await publishReply(message, { error: 'Computer is busy' });
                    return;
                }
                socket.requests.set(message.id, message);
                socket.ws.send(
                    JSON.stringify({
                        id: message.id,
                        method: message.method,
                        serverId: message.serverId,
                        params: message.params,
                        deadline: message.deadline,
                    }),
                );
            }
        } catch {
            /* Malformed pub/sub frames never enter the tool protocol. */
        }
    });
    await subscriber.subscribe(channel);

    async function rpc(deviceId, serverId, method, params) {
        const presence = await get(`presence:${deviceId}`);
        if (!presence) throw fail(409, 'Computer is offline');
        const id = randomUUID();
        const result = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(
                    fail(
                        504,
                        'Connection or tool timed out. The action may have run; check the local app before retrying.',
                    ),
                );
            }, rpcTimeout);
            pending.set(id, { resolve, reject, timer });
        });
        try {
            const delivered = await redis.publish(
                key(`instance:${presence.instance}`),
                JSON.stringify({
                    kind: 'request',
                    id,
                    deviceId,
                    serverId,
                    method,
                    params,
                    connectionId: presence.connectionId,
                    replyTo: channel,
                    deadline: Date.now() + rpcTimeout,
                }),
            );
            if (!delivered) throw fail(409, 'Computer is offline');
        } catch (error) {
            const request = pending.get(id);
            if (request) {
                clearTimeout(request.timer);
                pending.delete(id);
                request.reject(error);
            }
        }
        const reply = await result;
        if (reply.error) throw fail(502, reply.error);
        return reply.result;
    }
    const server = http.createServer(async (req, res) => {
        try {
            const path = new URL(req.url, 'http://relay').pathname;
            if (path === '/healthcheck' && req.method === 'GET') {
                await redis.ping();
                return json(res, 200, { status: 'ok' });
            }
            if (path === '/v1/pair/start' && req.method === 'POST') {
                // Trust no caller-supplied forwarding headers for this limit.
                await rateLimit(
                    `pair:${hash(req.socket.remoteAddress || '')}`,
                    30,
                    600,
                );
                const data = await body(req);
                const id = randomUUID();
                const token = secret();
                const code = randomBytes(6).toString('hex').toUpperCase();
                const device = {
                    id,
                    name: String(data.name || 'Computer').slice(0, 100),
                    tokenHash: hash(token),
                    servers: [],
                };
                await redis
                    .multi()
                    .set(key(`device:${id}`), JSON.stringify(device), 'EX', 600)
                    .set(key(`token:${device.tokenHash}`), id, 'EX', 600)
                    .set(key(`pair:${hash(code)}`), id, 'EX', 600)
                    .exec();
                return json(res, 201, {
                    deviceId: id,
                    token,
                    code,
                    expiresIn: 600,
                });
            }
            if (path === '/v1/pair/status' && req.method === 'GET') {
                const d = await deviceAuth(bearer(req));
                return json(res, d.owner ? 200 : 202, {
                    paired: Boolean(d.owner),
                });
            }
            if (path === '/v1/handoff/complete' && req.method === 'POST') {
                if (req.headers.origin)
                    throw fail(403, 'Native companion required');
                const device = await deviceAuth(bearer(req));
                const data = await body(req);
                if (!/^[a-zA-Z0-9_-]{43}$/.test(data.ticket || ''))
                    throw fail(400, 'Invalid setup link');
                const completionKey = key(`setup:${hash(data.ticket)}`);
                const completed = await redis.eval(
                    `local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end; local s=cjson.decode(raw); if s.deviceId~=ARGV[1] or s.owner~=ARGV[2] then return 0 end; s.complete=true; redis.call('SET',KEYS[1],cjson.encode(s),'KEEPTTL'); return 1`,
                    1,
                    completionKey,
                    device.id,
                    device.owner,
                );
                if (!completed) throw fail(410, 'Setup link expired');
                return json(res, 200, { complete: true });
            }
            if (
                ['/v1/handoff/inspect', '/v1/handoff/claim'].includes(path) &&
                req.method === 'POST'
            ) {
                if (req.headers.origin)
                    throw fail(403, 'Open the native companion');
                await rateLimit(
                    `handoff:${hash(req.socket.remoteAddress || '')}`,
                    120,
                    600,
                );
                const data = await body(req);
                if (!/^[a-zA-Z0-9_-]{43}$/.test(data.ticket || ''))
                    throw fail(400, 'Invalid setup link');
                const ticketKey = key(`handoff:${hash(data.ticket)}`);
                const encrypted = await redis.get(ticketKey);
                if (!encrypted)
                    throw fail(
                        410,
                        'Setup link expired. Open Concierge and connect again.',
                    );
                const handoff = codec.open(encrypted);
                if (data.site !== handoff.site)
                    throw fail(403, 'Setup site does not match');
                if (path.endsWith('/inspect'))
                    return json(res, 200, {
                        site: handoff.site,
                        account: handoff.account,
                        intent: handoff.intent,
                    });
                // Reopening setup for the same account reuses the computer. A
                // different account gets a fresh device with no enabled tools.
                const previous = bearer(req)
                    ? await deviceAuth(bearer(req)).catch(() => null)
                    : null;
                const reused = previous?.owner === handoff.owner;
                const id = reused ? previous.id : randomUUID();
                const token = reused ? bearer(req) : secret();
                const device = reused
                    ? previous
                    : {
                          id,
                          name: String(data.name || 'Computer').slice(0, 100),
                          tokenHash: hash(token),
                          servers: [],
                          owner: handoff.owner,
                      };
                const claimed = await redis.eval(
                    `
                    if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
                    if ARGV[4]=='1' then
                        local raw=redis.call('GET',KEYS[2]); if not raw or cjson.decode(raw).owner~=ARGV[5] then return 0 end
                    else
                        redis.call('SET',KEYS[2],ARGV[2]); redis.call('SET',KEYS[3],ARGV[3]); redis.call('SADD',KEYS[4],ARGV[3])
                    end
                    redis.call('SET',KEYS[5],ARGV[6],'EX',600); redis.call('DEL',KEYS[1]); return 1
                `,
                    5,
                    ticketKey,
                    key(`device:${id}`),
                    key(`token:${device.tokenHash}`),
                    ownerKey(handoff.owner),
                    key(`setup:${hash(data.ticket)}`),
                    encrypted,
                    JSON.stringify(device),
                    id,
                    reused ? '1' : '0',
                    handoff.owner,
                    JSON.stringify({ owner: handoff.owner, deviceId: id }),
                );
                if (!claimed)
                    throw fail(410, 'Setup link expired or already used');
                return json(res, 200, {
                    deviceId: id,
                    token,
                    reused,
                    account: handoff.account,
                });
            }
            if (path.startsWith('/v1/admin/')) {
                if (!equal(bearer(req), adminKey))
                    throw fail(401, 'Authorization required');
                const data = await body(req);
                const owner = requireOwner(data.owner);
                if (req.method !== 'POST') throw fail(405, 'Use POST');
                if (path === '/v1/admin/handoff') {
                    await rateLimit(`setup:${hash(owner)}`, 30, 600);
                    let site, intent;
                    try {
                        site = new URL(data.site);
                        if (
                            site.origin !== data.site ||
                            (site.protocol !== 'https:' &&
                                !(
                                    site.protocol === 'http:' &&
                                    ['127.0.0.1', 'localhost'].includes(
                                        site.hostname,
                                    )
                                ))
                        )
                            throw new Error();
                        intent = setupIntent(data.intent);
                    } catch {
                        throw fail(400, 'Invalid setup request');
                    }
                    const ticket = secret();
                    await redis.set(
                        key(`handoff:${hash(ticket)}`),
                        codec.seal({
                            owner,
                            site: site.origin,
                            account: String(data.account || '').slice(0, 200),
                            intent,
                        }),
                        'EX',
                        600,
                    );
                    return json(res, 201, { ticket, expiresIn: 600 });
                }
                if (path === '/v1/admin/handoff-status') {
                    if (!/^[a-zA-Z0-9_-]{43}$/.test(data.ticket || ''))
                        throw fail(400, 'Invalid setup link');
                    const setup = await get(`setup:${hash(data.ticket)}`);
                    if (!setup || setup.owner !== owner)
                        return json(res, 200, { paired: false });
                    const device = await get(`device:${setup.deviceId}`);
                    const online = Boolean(
                        await redis.exists(key(`presence:${setup.deviceId}`)),
                    );
                    return json(res, 200, {
                        paired: Boolean(
                            setup.complete && device?.owner === owner && online,
                        ),
                    });
                }
                if (path === '/v1/admin/pair') {
                    await rateLimit(`approve:${hash(owner)}`, 20, 600);
                    const code = String(data.code || '')
                        .replace(/[\s-]/g, '')
                        .toUpperCase();
                    if (!/^[A-F0-9]{12}$/.test(code))
                        throw fail(400, 'Invalid pairing code');
                    const pairKey = key(`pair:${hash(code)}`);
                    const id = await redis.get(pairKey);
                    if (!id)
                        throw fail(404, 'Pairing code expired or already used');
                    // Atomic claim prevents two accounts approving the same device.
                    const claimed = await redis.eval(
                        `
                        local raw=redis.call('GET',KEYS[2]); if not raw or redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
                        local d=cjson.decode(raw); if d.owner then return 0 end
                        d.owner=ARGV[2]; redis.call('SET',KEYS[2],cjson.encode(d)); redis.call('PERSIST',KEYS[3]);
                        redis.call('SADD',KEYS[4],ARGV[1]); redis.call('DEL',KEYS[1]); return 1
                    `,
                        4,
                        pairKey,
                        key(`device:${id}`),
                        key(`token:${(await get(`device:${id}`))?.tokenHash}`),
                        ownerKey(owner),
                        id,
                        owner,
                    );
                    if (!claimed)
                        throw fail(409, 'Pairing code expired or already used');
                    return json(res, 200, { paired: true });
                }
                if (path === '/v1/admin/devices')
                    return json(res, 200, {
                        devices: await listDevices(owner),
                    });
                if (path === '/v1/admin/revoke') {
                    const d =
                        ID.test(data.deviceId || '') &&
                        (await get(`device:${data.deviceId}`));
                    if (!d || d.owner !== owner)
                        throw fail(404, 'Computer not found');
                    // Authorization is removed before closing any live connection.
                    await redis
                        .multi()
                        .del(key(`device:${d.id}`), key(`token:${d.tokenHash}`))
                        .srem(ownerKey(owner), d.id)
                        .exec();
                    const presence = await get(`presence:${d.id}`);
                    await redis.del(key(`presence:${d.id}`));
                    if (presence)
                        await redis.publish(
                            key(`instance:${presence.instance}`),
                            JSON.stringify({ kind: 'revoke', deviceId: d.id }),
                        );
                    return json(res, 200, { disconnected: true });
                }
                if (path === '/v1/admin/config') {
                    const devices = await listDevices(owner);
                    const config = {};
                    for (const d of devices) {
                        if (!d.online) continue;
                        const token = secret();
                        const serverIds = d.servers.map((s) => s.id);
                        await redis.set(
                            key(`grant:${hash(token)}`),
                            JSON.stringify({
                                owner,
                                deviceId: d.id,
                                serverIds,
                            }),
                            'EX',
                            3600,
                        );
                        for (const s of d.servers)
                            config[
                                `local-${hash(`${d.id}:${s.id}`).slice(0, 12)}`
                            ] = {
                                type: 'local-companion',
                                deviceId: d.id,
                                serverId: s.id,
                                name: `${s.name} (${d.name})`,
                                token,
                            };
                    }
                    return json(res, 200, { config });
                }
            }
            if (path === '/v1/rpc' && req.method === 'POST') {
                const grant = await get(`grant:${hash(bearer(req))}`);
                if (!grant) throw fail(401, 'Local tool authorization expired');
                const data = await body(req);
                const device = await get(`device:${grant.deviceId}`);
                if (!device || device.owner !== grant.owner)
                    throw fail(403, 'Computer disconnected');
                if (
                    data.deviceId !== grant.deviceId ||
                    !grant.serverIds.includes(data.serverId)
                )
                    throw fail(403, 'Local server is not authorized');
                if (!['tools/list', 'tools/call'].includes(data.method))
                    throw fail(400, 'Unsupported method');
                await rateLimit(`rpc:${grant.deviceId}`, 120, 60);
                return json(
                    res,
                    200,
                    await rpc(
                        data.deviceId,
                        data.serverId,
                        data.method,
                        data.params,
                    ),
                );
            }
            throw fail(404, 'Not found');
        } catch (error) {
            json(res, error.status || 503, {
                error: error.status
                    ? error.message
                    : 'Companion service unavailable',
            });
        }
    });
    server.on('upgrade', (req, socket, head) => {
        (async () => {
            if (req.url !== '/v1/connect' || req.headers.origin)
                throw fail(401, 'Native companion required');
            const device = await deviceAuth(bearer(req));
            if (!device.owner) throw fail(401, 'Pairing required');
            wss.handleUpgrade(req, socket, head, (ws) =>
                wss.emit('connection', ws, device),
            );
        })().catch(() => {
            socket.end(
                'HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n',
            );
        });
    });
    wss.on('connection', (ws, device) => {
        const connectionId = randomUUID();
        sockets.get(device.id)?.ws.close(4000, 'Connection replaced');
        const entry = {
            ws,
            connectionId,
            requests: new Map(),
            alive: true,
            ready: false,
        };
        sockets.set(device.id, entry);
        const presence = JSON.stringify({ instance, connectionId });
        const helloTimer = setTimeout(
            () => ws.close(4000, 'No server manifest'),
            10000,
        );
        ws.on('pong', () => {
            entry.alive = true;
        });
        ws.on('message', async (raw) => {
            try {
                const message = JSON.parse(raw);
                if (message.type === 'hello' && !entry.ready) {
                    if (
                        !Array.isArray(message.servers) ||
                        message.servers.length > 30
                    )
                        throw new Error();
                    const ids = new Set();
                    const servers = message.servers.map((s) => {
                        if (
                            !ID.test(s.id) ||
                            ids.has(s.id) ||
                            typeof s.name !== 'string'
                        )
                            throw new Error();
                        ids.add(s.id);
                        return { id: s.id, name: s.name.slice(0, 100) };
                    });
                    // Do not resurrect a device revoked while its handshake was in flight.
                    const saved = await redis.eval(
                        `local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end; local d=cjson.decode(raw); d.servers=cjson.decode(ARGV[1]); redis.call('SET',KEYS[1],cjson.encode(d)); redis.call('SET',KEYS[2],ARGV[2],'EX',45); return 1`,
                        2,
                        key(`device:${device.id}`),
                        key(`presence:${device.id}`),
                        JSON.stringify(servers),
                        presence,
                    );
                    if (!saved) throw new Error();
                    entry.ready = true;
                    clearTimeout(helloTimer);
                    ws.send(JSON.stringify({ type: 'ready' }));
                } else if (message.id && entry.requests.has(message.id)) {
                    const request = entry.requests.get(message.id);
                    entry.requests.delete(message.id);
                    const live = await get(`device:${device.id}`);
                    await publishReply(
                        request,
                        live
                            ? { result: message.result, error: message.error }
                            : { error: 'Computer disconnected' },
                    );
                } else throw new Error();
            } catch {
                ws.close(4002, 'Invalid companion message');
            }
        });
        const heartbeat = setInterval(async () => {
            try {
                if (!entry.alive) return ws.terminate();
                entry.alive = false;
                ws.ping();
                if (entry.ready) {
                    const renewed = await redis.eval(
                        "if redis.call('GET',KEYS[1])==ARGV[1] and redis.call('EXISTS',KEYS[2])==1 then return redis.call('EXPIRE',KEYS[1],45) end; return 0",
                        2,
                        key(`presence:${device.id}`),
                        key(`device:${device.id}`),
                        presence,
                    );
                    if (!renewed)
                        ws.close(4001, 'Connection replaced or disconnected');
                }
                for (const [id, request] of entry.requests)
                    if (request.deadline < Date.now())
                        entry.requests.delete(id);
            } catch {
                ws.terminate();
            }
        }, 15000);
        ws.on('error', () => {});
        ws.on('close', async () => {
            clearInterval(heartbeat);
            clearTimeout(helloTimer);
            if (sockets.get(device.id) === entry) sockets.delete(device.id);
            try {
                await redis.eval(
                    "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0",
                    1,
                    key(`presence:${device.id}`),
                    presence,
                );
                await Promise.all(
                    [...entry.requests.values()].map((request) =>
                        publishReply(request, {
                            error: 'Connection lost. The action may have run; check the local app before retrying.',
                        }),
                    ),
                );
            } catch {
                /* Callers still have a hard deadline. */
            }
        });
    });
    return {
        server,
        async close() {
            for (const entry of sockets.values()) entry.ws.terminate();
            for (const p of pending.values()) {
                clearTimeout(p.timer);
                p.reject(
                    fail(503, 'Relay stopped; check local app before retrying'),
                );
            }
            pending.clear();
            await new Promise((resolve) => wss.close(resolve));
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
            await subscriber.quit();
        },
    };
}
