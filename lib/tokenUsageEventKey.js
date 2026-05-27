import crypto from 'crypto';

const normalizeNumber = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
};

const sortObject = (value) => {
    if (Array.isArray(value)) {
        return value.map(sortObject);
    }

    if (!value || typeof value !== 'object') {
        return value;
    }

    return Object.keys(value).sort().reduce((accum, key) => {
        accum[key] = sortObject(value[key]);
        return accum;
    }, {});
};

export const buildTokenUsageEventIdentity = (payload, { timestamp = null } = {}) => {
    const identity = {
        event: 'token_usage',
        api_key_id: payload?.api_key_id ?? null,
        request_id: payload?.request_id ?? null,
        model: payload?.model ?? null,
        route: payload?.route ?? null,
        stream: Boolean(payload?.stream),
        input_tokens: normalizeNumber(payload?.input_tokens),
        output_tokens: normalizeNumber(payload?.output_tokens),
        total_tokens: normalizeNumber(payload?.total_tokens),
        cache_creation_input_tokens: normalizeNumber(payload?.cache_creation_input_tokens),
        cache_read_input_tokens: normalizeNumber(payload?.cache_read_input_tokens),
        server_tool_use: payload?.server_tool_use && typeof payload.server_tool_use === 'object'
            ? sortObject(payload.server_tool_use)
            : null
    };

    // Imported log events can fall back to their log timestamp if request_id is absent.
    if (!identity.request_id && timestamp) {
        identity.timestamp = String(timestamp);
    }

    return identity;
};

export const buildTokenUsageEventKey = (payload, options = {}) => {
    const identity = buildTokenUsageEventIdentity(payload, options);
    return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
};
