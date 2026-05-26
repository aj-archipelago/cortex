import logger from './logger.js';

const START_TIME = Symbol('latencyTraceStartTime');

const isEnabled = () => {
    const value = process.env.CORTEX_LATENCY_TRACE;
    return value === '1' || value === 'true' || value === 'yes';
};

const nowMs = () => Number(process.hrtime.bigint() / 1000000n);

const sanitize = (value) => {
    if (value === undefined || value === null) return value;
    if (typeof value === 'string') return value.length > 240 ? `${value.slice(0, 240)}...` : value;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return `[array:${value.length}]`;
    if (typeof value === 'object') {
        const out = {};
        for (const [key, item] of Object.entries(value)) {
            if (/key|token|secret|password|auth|credential/i.test(key)) {
                out[key] = '[redacted]';
            } else if (typeof item === 'string') {
                out[key] = item.length > 240 ? `${item.slice(0, 240)}...` : item;
            } else if (Array.isArray(item)) {
                out[key] = `[array:${item.length}]`;
            } else if (item && typeof item === 'object') {
                out[key] = `[object:${Object.keys(item).length}]`;
            } else {
                out[key] = item;
            }
        }
        return out;
    }
    return String(value);
};

const emit = (event) => {
    if (!isEnabled()) return;
    logger.info(`[latency] ${JSON.stringify({
        t: new Date().toISOString(),
        ...sanitize(event),
    })}`);
};

const start = (name, fields = {}) => {
    if (!isEnabled()) return null;
    const span = {
        name,
        fields,
        [START_TIME]: nowMs(),
    };
    emit({ event: 'start', span: name, ...fields });
    return span;
};

const end = (span, fields = {}) => {
    if (!span || !isEnabled()) return;
    emit({
        event: 'end',
        span: span.name,
        durationMs: nowMs() - span[START_TIME],
        ...span.fields,
        ...fields,
    });
};

const mark = (name, fields = {}) => {
    emit({ event: 'mark', span: name, ...fields });
};

export default {
    isEnabled,
    mark,
    start,
    end,
};
