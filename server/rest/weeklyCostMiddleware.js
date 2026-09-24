import { config } from '../../config.js';
import logger from '../../lib/logger.js';
import { WeeklyCostLimits } from '../../lib/WeeklyCostLimits.js';

export const weeklyCostLimits = new WeeklyCostLimits({
    getModels: () => config.get('models'),
    getRedisUri: () => process.env.COST_LIMIT_REDIS_URL || config.get('storageConnectionString'),
    onError: error => logger.warn(`Weekly budget accounting degraded: ${error.name || 'Error'} (${error.code || 'unknown'})`),
});

// A client-error response confirms rejection before generation. Other failures
// may have used tokens, but missing usage is not evidence for a dollar debit.
export function markWeeklyCostUpstreamRejected(req, error) {
    const status = error.response?.status;
    if (status >= 400 && status < 500 && status !== 408) req.weeklyCostUpstreamRejected = true;
}

export function createWeeklyCostMiddleware(limits = weeklyCostLimits, {
    onMissingUsage = event => logger.warn(JSON.stringify(event)),
} = {}) {
    return async (req, res, next) => {
        try {
            req.weeklyCostBudget = await limits.admit(req.cortexApiKeyId);
            if (req.weeklyCostBudget) {
                let missingReported = false;
                const settleUnreported = () => {
                    if (missingReported || req.weeklyCostRecorded || req.weeklyCostUpstreamRejected || !req.weeklyCostUpstreamStarted) return;
                    missingReported = true;
                    // SSE framing, JSON, images, and opaque prior context are
                    // not token counts. Report the gap without consuming the
                    // once-only debit flag: late provider usage must still count.
                    onMissingUsage({
                        event: 'weekly_cost_usage_missing',
                        request_id: req.cortexUsageRequestId || null,
                        model: req.body?.model || null,
                        route: req.path || null,
                        stream: Boolean(req.body?.stream),
                        status: res.statusCode,
                    });
                };
                res.once('finish', settleUnreported);
                res.once('close', settleUnreported);
            }
            next();
        } catch (error) {
            if (error.code === 'weekly_cost_limit_exceeded') {
                const budget = error.budget;
                res.set('Retry-After', String(Math.max(1, Math.ceil((+budget.end - Date.now()) / 1000))));
                res.status(429).json({ error: {
                    type: 'insufficient_quota', code: error.code,
                    message: 'Weekly estimated cost limit reached. Access resets automatically at the indicated time.',
                    weekly_limit_usd: budget.weeklyUsd, estimated_spend_usd: budget.spentMicros / 1_000_000,
                    resets_at: budget.end.toISOString(),
                } });
            } else {
                logger.error(`Weekly cost admission failed: ${error.name || 'Error'} (${error.code || 'unknown'})`);
                res.status(503).json({ error: { type: 'server_error', code: 'cost_limit_unavailable', message: 'Unable to verify the weekly cost allowance. Please retry shortly.' } });
            }
        }
    };
}
