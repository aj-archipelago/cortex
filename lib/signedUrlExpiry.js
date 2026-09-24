// Expiry is a freshness hint, never proof of ownership or accessibility.
export const IMAGE_URL_EXPIRY_MARGIN_MS = 60_000;
const MAX_PARSED_URLS = 512;
const parsedUrls = new Map();

function parseTimestamp(value) {
    if (!value || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}

export function getSignedUrlTiming(value) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return null;
    if (parsedUrls.has(value)) return parsedUrls.get(value);
    let timing = null;
    try {
        const url = new URL(value);
        const params = url.searchParams;
        let expiresAt = null;
        let startsAt = null;
        if (params.has('se') && params.has('sig')) {
            expiresAt = parseTimestamp(params.get('se'));
            startsAt = params.has('st') ? parseTimestamp(params.get('st')) : null;
            if (params.has('st') && startsAt === null) expiresAt = null;
            // User-delegation SAS cannot outlive its signing key.
            if (params.has('ske')) {
                const keyExpiry = parseTimestamp(params.get('ske'));
                expiresAt = expiresAt !== null && keyExpiry !== null ? Math.min(expiresAt, keyExpiry) : null;
            }
        } else if (params.has('X-Goog-Date') && params.has('X-Goog-Expires')) {
            const date = params.get('X-Goog-Date');
            const match = date.match(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/);
            const issuedAt = match ? parseTimestamp(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`) : null;
            const seconds = params.get('X-Goog-Expires');
            if (issuedAt !== null && /^\d+$/.test(seconds) && Number(seconds) > 0) {
                expiresAt = issuedAt + Number(seconds) * 1000;
            }
        } else if (params.has('GoogleAccessId') && /^\d+$/.test(params.get('Expires') || '')) {
            expiresAt = Number(params.get('Expires')) * 1000;
        }
        if (expiresAt !== null && Number.isFinite(expiresAt)) {
            timing = { expiresAt, startsAt, versioned: params.has('snapshot') || params.has('versionid') };
        }
    } catch { /* Unknown or malformed expiry must not be treated as fresh. */ }
    if (parsedUrls.size >= MAX_PARSED_URLS) parsedUrls.delete(parsedUrls.keys().next().value);
    parsedUrls.set(value, timing);
    return timing;
}

export function isSignedUrlFresh(url, { now = Date.now(), marginMs = IMAGE_URL_EXPIRY_MARGIN_MS, maxRemainingMs = Infinity } = {}) {
    const timing = getSignedUrlTiming(url);
    return Boolean(timing && (timing.startsAt === null || timing.startsAt <= now)
        && timing.expiresAt > now + marginMs && timing.expiresAt <= now + maxRemainingMs);
}
