// Keep the hard deadline in sync with cortex-whisper-wrapper/worker.py.
export const WHISPER_JOB_MS = 240000;
export const whisperExecutionPolicy = Object.freeze({
    maxAttempts: 3,
    retryStatuses: [429],
    allowDuplicateRequests: false,
    timeoutMs: WHISPER_JOB_MS + 20000,
});

export function cleanupDeadline(deadlineSeconds, error) {
    // No dispatch means no remote job owns these inputs.
    if (!Number.isFinite(deadlineSeconds)) return 0;
    if (error?.status === 429 || error?.headers?.['x-whisper-job-settled'] === 'true') return 0;
    return deadlineSeconds * 1000 + 10000;
}

export async function settleBatch(uris, processChunk) {
    const results = await Promise.allSettled(uris.map(processChunk));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    return results.map(result => result.value);
}

export async function waitForCleanup(deadline, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) {
    const remaining = deadline - now();
    if (remaining > 0) await sleep(remaining);
}
