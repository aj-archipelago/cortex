// clientToolCallbacks.js
// Storage and management for pending client-side tool callbacks

import logger from '../lib/logger.js';

// Map to store pending client tool callbacks
// Key: toolCallbackId, Value: { resolve, reject, timeout, requestId }
const pendingCallbacks = new Map();

// Default timeout for client tool responses (60 seconds)
const DEFAULT_TIMEOUT = 60000;

/**
 * Register a pending client tool callback
 * @param {string} toolCallbackId - Unique ID for this tool call
 * @param {string} requestId - The request ID for logging/tracking
 * @param {number} timeoutMs - Timeout in milliseconds
 * @returns {Promise} Promise that resolves when client submits the result
 */
export function waitForClientToolResult(toolCallbackId, requestId, timeoutMs = DEFAULT_TIMEOUT) {
    return new Promise((resolve, reject) => {
        // Set up timeout
        const timeout = setTimeout(() => {
            pendingCallbacks.delete(toolCallbackId);
            logger.error(`Client tool callback timeout for ${toolCallbackId} (requestId: ${requestId})`);
            reject(new Error(`Client tool execution timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        // Store the callback
        pendingCallbacks.set(toolCallbackId, {
            resolve,
            reject,
            timeout,
            requestId,
            createdAt: Date.now()
        });

        logger.info(`Registered client tool callback: ${toolCallbackId} (requestId: ${requestId})`);
    });
}

/**
 * Resolve a pending client tool callback with the result
 * @param {string} toolCallbackId - The tool callback ID
 * @param {object} result - The result from the client
 * @returns {boolean} True if callback was found and resolved
 */
export function resolveClientToolCallback(toolCallbackId, result) {
    const callback = pendingCallbacks.get(toolCallbackId);
    
    if (!callback) {
        logger.warn(`No pending callback found for toolCallbackId: ${toolCallbackId}`);
        return false;
    }

    // Clear the timeout
    clearTimeout(callback.timeout);
    
    // Remove from pending
    pendingCallbacks.delete(toolCallbackId);
    
    logger.info(`Resolved client tool callback: ${toolCallbackId} (requestId: ${callback.requestId})`);
    
    // Resolve the promise
    callback.resolve(result);
    
    return true;
}

/**
 * Reject a pending client tool callback with an error
 * @param {string} toolCallbackId - The tool callback ID
 * @param {Error} error - The error
 * @returns {boolean} True if callback was found and rejected
 */
export function rejectClientToolCallback(toolCallbackId, error) {
    const callback = pendingCallbacks.get(toolCallbackId);
    
    if (!callback) {
        logger.warn(`No pending callback found for toolCallbackId: ${toolCallbackId}`);
        return false;
    }

    // Clear the timeout
    clearTimeout(callback.timeout);
    
    // Remove from pending
    pendingCallbacks.delete(toolCallbackId);
    
    logger.info(`Rejected client tool callback: ${toolCallbackId} (requestId: ${callback.requestId})`);
    
    // Reject the promise
    callback.reject(error);
    
    return true;
}

/**
 * Get count of pending callbacks (for monitoring)
 */
export function getPendingCallbackCount() {
    return pendingCallbacks.size;
}

/**
 * Clean up old callbacks (for maintenance)
 */
export function cleanupOldCallbacks(maxAgeMs = 120000) {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [id, callback] of pendingCallbacks.entries()) {
        if (now - callback.createdAt > maxAgeMs) {
            clearTimeout(callback.timeout);
            pendingCallbacks.delete(id);
            callback.reject(new Error('Callback expired during cleanup'));
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        logger.info(`Cleaned up ${cleaned} old client tool callbacks`);
    }
    
    return cleaned;
}

