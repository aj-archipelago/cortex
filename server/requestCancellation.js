import { requestState } from './requestState.js';

// Do not create requestState entries on instances which do not own the request:
// placeholders would prevent subscription forwarding to its actual owner.
export function cancelLocalRequest(requestId, state = requestState) {
    const request = state[requestId];
    if (!request) return false;
    request.canceled = true;
    request.abortRequest?.();
    return true;
}

export function armRequestDeadline(requestId, value, state = requestState) {
    if (value === undefined || value === null) return;
    const deadline = Number(value);
    if (!Number.isSafeInteger(deadline) || deadline <= 0 || deadline > Date.now() + 24 * 3600000) {
        throw new Error('Invalid Cortex request deadline');
    }
    const request = state[requestId] ||= {};
    clearTimeout(request.deadlineTimer);
    request.deadline = deadline;
    if (deadline <= Date.now()) {
        cancelLocalRequest(requestId, state);
        throw new Error('Cortex request deadline exceeded');
    }
    request.deadlineTimer = setTimeout(() => cancelLocalRequest(requestId, state), deadline - Date.now());
    request.deadlineTimer.unref?.();
}

export function clearRequestDeadline(requestId, state = requestState) {
    const request = state[requestId];
    if (!request) return;
    clearTimeout(request.deadlineTimer);
    delete request.deadlineTimer;
}
