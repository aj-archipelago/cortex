import {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes,
} from 'node:crypto';

// Short-lived setup secrets stay encrypted in Redis. No executable, environment,
// arbitrary headers, or filesystem paths can be supplied by the browser.
export function handoffCodec(adminKey) {
    const key = createHash('sha256')
        .update(`companion-handoff-v1:${adminKey}`)
        .digest();
    return {
        seal(value) {
            const iv = randomBytes(12);
            const cipher = createCipheriv('aes-256-gcm', key, iv);
            const data = Buffer.concat([
                cipher.update(JSON.stringify(value)),
                cipher.final(),
            ]);
            return Buffer.concat([iv, cipher.getAuthTag(), data]).toString(
                'base64url',
            );
        },
        open(value) {
            const data = Buffer.from(value, 'base64url');
            const cipher = createDecipheriv(
                'aes-256-gcm',
                key,
                data.subarray(0, 12),
            );
            cipher.setAuthTag(data.subarray(12, 28));
            return JSON.parse(
                Buffer.concat([
                    cipher.update(data.subarray(28)),
                    cipher.final(),
                ]).toString(),
            );
        },
    };
}

export function setupIntent(value = { kind: 'connect' }) {
    if (value.kind === 'connect' || value.kind === 'files')
        return { kind: value.kind };
    if (
        value.kind !== 'server' ||
        typeof value.name !== 'string' ||
        !value.name.trim()
    )
        throw new Error('Invalid connector');
    const url = new URL(value.url);
    if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash ||
        url.href.length > 2048
    )
        throw new Error('Invalid connector address');
    if (
        value.token &&
        (typeof value.token !== 'string' ||
            value.token.length > 8192 ||
            /[\r\n]/.test(value.token))
    )
        throw new Error('Invalid access token');
    if (value.type && !['streamable-http', 'sse'].includes(value.type))
        throw new Error('Invalid connector type');
    return {
        kind: 'server',
        name: value.name.trim().slice(0, 100),
        url: url.href,
        type: value.type || 'streamable-http',
        token: value.token || '',
    };
}
