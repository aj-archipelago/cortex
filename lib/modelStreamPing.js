// modelStreamPing.js
//
// Lightweight streaming ping used by modelSampler to populate TTFB stats.
//
// Why this exists: the picker in requestExecutor.js prefers TTFB over total
// callDuration. Live agent traffic streams and so produces TTFB samples; if
// the sampler sent non-streaming requests it would only produce
// callDuration, and the picker would compare TTFB-of-busy-models against
// callDuration-of-idle-models — apples to oranges, busy member always wins.
//
// We can't reuse the pathway/resolver layer for this because callPathway +
// asyncResolve double-handle the stream and hang on the second pass. So we
// drop down a level: instantiate the plugin via ModelExecutor's
// type-to-plugin mapping, build a CortexRequest, call plugin.execute with
// stream:true, listen for the first byte, record TTFB, destroy.

import { modelEndpoints } from './requestExecutor.js';
import { ModelExecutor } from '../server/modelExecutor.js';
import CortexRequest from './cortexRequest.js';
import { Prompt } from '../server/prompt.js';
import logger from './logger.js';

const PING_TIMEOUT_MS = 15_000;

// Minimal pathway shape consumed by ModelPlugin.constructor. Plugins read
// `name`, `temperature`, `prompt`, and any inputParameters defaults.
const PING_PATHWAY = {
    name: 'modelStreamPing',
    requestLoggingDisabled: true,
    suppressErrorLogging: true,
    timeout: 10,
    inputParameters: {},
    prompt: [new Prompt({ messages: [{ role: 'user', content: 'ping' }] })],
};

// Both knobs to cap the response — different providers honor different
// names. Whichever the plugin picks, it's bounded.
const PING_PARAMS = {
    stream: true,
    max_tokens: 16,
    max_completion_tokens: 16,
    max_output_tokens: 16,
};

const withTimeout = async (promise, timeoutMs, timeoutMessage) => {
    let timeoutHandle;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timeoutHandle = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timeoutHandle);
    }
};

const streamPing = async (memberName) => {
    const model = modelEndpoints[memberName];
    if (!model?.endpoints?.length) return;
    if (model.supportsStreaming === false) return;

    let plugin;
    try {
        plugin = new ModelExecutor(PING_PATHWAY, model).plugin;
    } catch (err) {
        // Unknown model.type — ModelExecutor throws when its switch can't
        // map. These don't belong in chat-style modelGroups anyway.
        logger.debug(`modelSampler ping ${memberName}: ${err?.message || err}`);
        return;
    }
    if (!plugin) return;

    // CortexRequest pulls `pathway` and `requestId` off pathwayResolver via
    // getters (lib/cortexRequest.js:159, 164). The plugin's executeRequest
    // dereferences pathway.name. Hand it a stand-in resolver.
    const cortexRequest = new CortexRequest({
        stream: true,
        bypassLimiter: true,
        pathwayResolver: {
            pathway: PING_PATHWAY,
            model,
            requestId: `ping-${memberName}-${Date.now()}`,
        },
    });

    let result;
    try {
        result = await withTimeout(
            plugin.execute(
                'ping',
                PING_PARAMS,
                PING_PATHWAY.prompt[0],
                cortexRequest,
            ),
            PING_TIMEOUT_MS,
            `modelSampler ping ${memberName} timed out before stream response`,
        );
    } catch (err) {
        logger.debug(`modelSampler ping ${memberName} failed: ${err?.message || err}`);
        return;
    }

    // Plugin returned a non-stream (model doesn't support streaming, or
    // provider responded synchronously). callDuration was already recorded
    // by endCall inside requestWithMonitor — nothing more to do.
    if (!result || typeof result.on !== 'function') return;

    await new Promise((resolve) => {
        let settled = false;
        let timeoutHandle;
        const cleanup = () => {
            if (settled) return;
            settled = true;
            result.off?.('data', onFirstByte);
            result.off?.('error', cleanup);
            result.off?.('end', cleanup);
            result.off?.('close', cleanup);
            try { result.destroy(); } catch { /* swallow */ }
            clearTimeout(timeoutHandle);
            resolve();
        };
        const onFirstByte = () => {
            if (settled) return;
            // Use the monitor + ttfbStart that requestWithMonitor stamped on
            // the stream. Same metric live agent traffic gets via
            // pathwayResolver.processStream — comparable across the picker.
            const monitor = result._cortexTtfbMonitor;
            const ttfbStart = result._cortexTtfbStart;
            if (monitor && ttfbStart) {
                try { monitor.recordTTFB(Date.now() - ttfbStart, 'ping'); } catch { /* swallow */ }
            }
            cleanup();
        };
        result.once('data', onFirstByte);
        result.once('error', cleanup);
        result.once('end', cleanup);
        result.once('close', cleanup);
        timeoutHandle = setTimeout(cleanup, PING_TIMEOUT_MS);
    });
};

export { streamPing, withTimeout };
