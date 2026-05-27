// modelSampler.js
//
// Background sampler that keeps TTFB / call-duration stats fresh on members of
// any modelGroup that haven't seen recent production traffic. The picker in
// requestExecutor.js needs fresh data to make speed-aware selections; without
// this, idle alternates would always look unknown and priority-1 would always
// win even when it slows down.
//
// Design constraints (do not regress):
//   - Zero impact on hot path: this runs on a setInterval, never blocks requests.
//   - No double-fire: a single in-flight cycle is enforced via a mutex flag.
//   - Sequential pings: no thundering herd against shared infra.
//   - Only pings members that are actually stale; production traffic naturally
//     keeps most members fresh and the sampler stays a no-op.

import { modelEndpoints, MODEL_SAMPLE_STALENESS_MS } from './requestExecutor.js';
import { streamPing } from './modelStreamPing.js';
import logger from './logger.js';
import { getModelGroupMembers } from './modelGroups.js';

// 15 min: matches MODEL_SAMPLE_STALENESS_MS so each tick re-pings every
// member whose only ping sample came from the previous cycle.
const SAMPLE_INTERVAL_MS = 15 * 60 * 1000;
const STARTUP_DELAY_MS = 10_000;
const SAMPLE_JITTER_RATIO = 0.2;

let timerHandle = null;
let cycleInFlight = false;

const jitteredDelayMs = (baseMs, random = Math.random) => {
    const jitterRange = baseMs * SAMPLE_JITTER_RATIO;
    return Math.round((baseMs - jitterRange) + (random() * jitterRange * 2));
};

const uniqueMembers = (groups) => {
    const seen = new Set();
    for (const group of Object.values(groups || {})) {
        for (const name of getModelGroupMembers(group)) {
            seen.add(name);
        }
    }
    return [...seen];
};

const memberIsStale = (memberName) => {
    const m = modelEndpoints[memberName];
    if (!m?.endpoints?.length) return false; // unknown model — nothing to sample
    // Stale if EVERY endpoint's ping sample is older than the threshold.
    // Live traffic is intentionally ignored here because model-group ranking
    // needs comparable sampler payloads, not arbitrary user workloads.
    return m.endpoints.every(ep => !ep.monitor || ep.monitor.getSampleAge('ping') >= MODEL_SAMPLE_STALENESS_MS);
};

const pingMember = async (memberName) => {
    try {
        await streamPing(memberName);
    } catch (error) {
        // Errors are expected (stale auth, deprovisioned models, etc.).
        // streamPing already records its own debug-level diagnostics; this
        // only fires if streamPing itself throws unexpectedly.
        logger.debug(`modelSampler ping failed for ${memberName}: ${error?.message || error}`);
    }
};

const runCycle = async (config) => {
    if (cycleInFlight) return;
    cycleInFlight = true;
    try {
        const groups = config.get('modelGroups') || {};
        const stale = uniqueMembers(groups).filter(memberIsStale);
        if (stale.length === 0) return;
        for (const name of stale) {
            await pingMember(name);
        }
    } finally {
        cycleInFlight = false;
    }
};

const scheduleNextCycle = (config, delayMs = jitteredDelayMs(SAMPLE_INTERVAL_MS)) => {
    timerHandle = setTimeout(() => {
        runCycle(config)
            .catch(() => {})
            .finally(() => {
                if (timerHandle) scheduleNextCycle(config);
            });
    }, delayMs);
    if (timerHandle.unref) timerHandle.unref(); // don't hold the event loop open
};

const startModelSampler = (config) => {
    if (timerHandle) return;
    const groups = config.get('modelGroups') || {};
    if (Object.keys(groups).length === 0) return; // no groups configured: nothing to sample
    scheduleNextCycle(config, jitteredDelayMs(STARTUP_DELAY_MS));
    logger.info(`modelSampler armed: interval=${SAMPLE_INTERVAL_MS}ms, jitter=${SAMPLE_JITTER_RATIO * 100}%, staleness=${MODEL_SAMPLE_STALENESS_MS}ms, groups=${Object.keys(groups).length}`);
};

const stopModelSampler = () => {
    if (timerHandle) {
        clearTimeout(timerHandle);
        timerHandle = null;
    }
};

export { startModelSampler, stopModelSampler, jitteredDelayMs };
