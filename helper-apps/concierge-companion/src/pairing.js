import { serviceOrigin, validateServers } from './runtime.js';

export function pairedConfiguration(previous, pending, result, addition) {
    if (
        !/^[a-zA-Z0-9_-]{43}$/.test(result.token || '') ||
        !/^[a-zA-Z0-9_-]{1,80}$/.test(result.deviceId || '')
    )
        throw new Error('Invalid setup response');
    // A new deployment must never claim it can reuse another site's local tools.
    const sameSite =
        previous.conciergeUrl === pending.conciergeUrl &&
        previous.relayUrl === pending.relayUrl;
    const servers = sameSite && result.reused === true ? previous.servers : [];
    return {
        conciergeUrl: pending.conciergeUrl,
        relayUrl: pending.relayUrl,
        token: result.token,
        deviceId: result.deviceId,
        account: String(result.account || '').slice(0, 200),
        servers: addition
            ? validateServers([
                  ...servers.filter(
                      (s) => !(addition.url && s.url === addition.url),
                  ),
                  addition,
              ])
            : servers,
    };
}

export function parseHandoff(value, development = false) {
    if (typeof value !== 'string' || value.length > 4096)
        throw new Error('Invalid setup link');
    const url = new URL(value);
    if (
        url.protocol !== 'concierge-companion:' ||
        url.hostname !== 'connect' ||
        (url.pathname && url.pathname !== '/') ||
        url.username ||
        url.password ||
        url.port ||
        url.hash
    )
        throw new Error('Invalid setup link');
    if (
        url.searchParams.size !== 2 ||
        !url.searchParams.has('site') ||
        !url.searchParams.has('ticket')
    )
        throw new Error('Invalid setup link');
    const ticket = url.searchParams.get('ticket');
    if (!/^[a-zA-Z0-9_-]{43}$/.test(ticket))
        throw new Error('Invalid setup link');
    return {
        conciergeUrl: serviceOrigin(url.searchParams.get('site'), development),
        ticket,
    };
}

export async function inspectHandoff(value, { request, development = false }) {
    const link = parseHandoff(value, development);
    const { data: discovery } = await request(
        link.conciergeUrl,
        '/api/companion/config',
    );
    if (!discovery.enabled)
        throw new Error(
            'Your Concierge administrator has not enabled companion connections',
        );
    const relayUrl = serviceOrigin(discovery.relayUrl, development);
    const { data } = await request(relayUrl, '/v1/handoff/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket: link.ticket, site: link.conciergeUrl }),
    });
    if (
        data.site !== link.conciergeUrl ||
        !['connect', 'files', 'server'].includes(data.intent?.kind)
    )
        throw new Error('Invalid setup response');
    let server;
    if (data.intent.kind === 'server') {
        server = validateServers([
            {
                id: crypto.randomUUID(),
                name: data.intent.name,
                type: data.intent.type,
                url: data.intent.url,
                headers: data.intent.token
                    ? { Authorization: `Bearer ${data.intent.token}` }
                    : {},
            },
        ])[0];
    }
    return {
        ...link,
        relayUrl,
        account: String(data.account || '').slice(0, 200),
        kind: data.intent.kind,
        server,
    };
}
