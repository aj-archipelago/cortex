// clientToolCallbacks.js
// Storage and management for pending client-side tool callbacks

import logger from '../lib/logger.js';
import Redis from 'ioredis';
import { config } from '../config.js';

// Map to store pending client tool callbacks
// Key: toolCallbackId, Value: { resolve, reject, timeout, requestId, lastHeartbeatAt }
const pendingCallbacks = new Map();

// Default timeout for client tool responses (5 minutes)
// Increased from 60s to 5min to accommodate longer operations like CreateWorkspace
const DEFAULT_TIMEOUT = 300000;

// Redis setup for cross-instance communication
const connectionString = config.get('storageConnectionString');
const clientToolCallbackChannel = 'clientToolCallbacks';
const clientToolHeartbeatChannel = 'clientToolCallbackHeartbeats';

const DEFAULT_INITIAL_HEARTBEAT_TIMEOUT = 10000;
const DEFAULT_HEARTBEAT_STALE_TIMEOUT = 15000;
const DEFAULT_HEARTBEAT_CHECK_INTERVAL = 1000;
const CLIENT_TOOL_HEARTBEAT_TIMEOUT_GUIDANCE =
    'Client-side tool heartbeat timed out; the result is unconfirmed, not necessarily failed. Verify the current state before reporting failure, and retry only if safe.';

let subscriptionClient;
let publisherClient;

if (connectionString) {
    logger.info(`Setting up Redis pub/sub for client tool callbacks on channel: ${clientToolCallbackChannel}`);
    
    try {
        subscriptionClient = new Redis(connectionString);
        subscriptionClient.on('error', (error) => {
            logger.error(`Redis subscriptionClient error (clientToolCallbacks): ${error}`);
        });
        
        subscriptionClient.on('connect', () => {
            subscriptionClient.subscribe(clientToolCallbackChannel, clientToolHeartbeatChannel, (error) => {
                if (error) {
                    logger.error(`Error subscribing to Redis client tool channels: ${error}`);
                } else {
                    logger.info(`Subscribed to client tool channels: ${clientToolCallbackChannel}, ${clientToolHeartbeatChannel}`);
                }
            });
        });
        
        subscriptionClient.on('message', (channel, message) => {
            try {
                if (channel === clientToolCallbackChannel) {
                    const { toolCallbackId, result } = JSON.parse(message);
                    logger.debug(`Received client tool callback via Redis: ${toolCallbackId}`);
                    
                    // Try to resolve it locally (will only work if this instance has the pending callback)
                    resolveClientToolCallbackLocal(toolCallbackId, result);
                } else if (channel === clientToolHeartbeatChannel) {
                    const { toolCallbackId, requestId, ts } = JSON.parse(message);
                    logger.debug(`Received client tool heartbeat via Redis: ${toolCallbackId}`);
                    recordClientToolHeartbeatLocal(toolCallbackId, requestId, ts);
                }
            } catch (error) {
                logger.error(`Error processing client tool message from Redis: ${error}`);
            }
        });
    } catch (error) {
        logger.error(`Redis connection error (clientToolCallbacks): ${error}`);
    }
    
    try {
        publisherClient = new Redis(connectionString);
        publisherClient.on('error', (error) => {
            logger.error(`Redis publisherClient error (clientToolCallbacks): ${error}`);
        });
    } catch (error) {
        logger.error(`Redis connection error (clientToolCallbacks): ${error}`);
    }
} else {
    logger.info('No Redis connection configured. Client tool callbacks will only work on single instance.');
}

/**
 * Register a pending client tool callback
 * @param {string} toolCallbackId - Unique ID for this tool call
 * @param {string} requestId - The request ID for logging/tracking
 * @param {number|object} timeoutOrOptions - Timeout in milliseconds or heartbeat options
 * @returns {Promise} Promise that resolves when client submits the result
 */
function normalizeWaitOptions(timeoutOrOptions) {
    if (typeof timeoutOrOptions === 'number') {
        return {
            maxTimeoutMs: timeoutOrOptions,
            requireHeartbeat: false,
        };
    }

    const options = timeoutOrOptions || {};
    return {
        maxTimeoutMs: options.maxTimeoutMs || DEFAULT_TIMEOUT,
        initialHeartbeatTimeoutMs:
            options.initialHeartbeatTimeoutMs || DEFAULT_INITIAL_HEARTBEAT_TIMEOUT,
        heartbeatStaleMs:
            options.heartbeatStaleMs || DEFAULT_HEARTBEAT_STALE_TIMEOUT,
        checkEveryMs:
            options.checkEveryMs || DEFAULT_HEARTBEAT_CHECK_INTERVAL,
        requireHeartbeat: options.requireHeartbeat !== false,
    };
}

function cleanupCallback(toolCallbackId, callback) {
    clearTimeout(callback.timeout);
    clearInterval(callback.heartbeatInterval);
    pendingCallbacks.delete(toolCallbackId);
}

export function waitForClientToolResult(toolCallbackId, requestId, timeoutOrOptions = DEFAULT_TIMEOUT) {
    const options = normalizeWaitOptions(timeoutOrOptions);

    return new Promise((resolve, reject) => {
        const createdAt = Date.now();
        const timeout = setTimeout(() => {
            const callback = pendingCallbacks.get(toolCallbackId);
            logger.error(`Client tool callback timeout for ${toolCallbackId} (requestId: ${requestId})`);
            if (callback) {
                callback.reject(
                    new Error(`Client tool execution timeout after ${options.maxTimeoutMs}ms`)
                );
            }
        }, options.maxTimeoutMs);

        let heartbeatInterval = null;
        if (options.requireHeartbeat) {
            heartbeatInterval = setInterval(() => {
                const callback = pendingCallbacks.get(toolCallbackId);
                if (!callback) return;

                const now = Date.now();
                if (
                    !callback.lastHeartbeatAt &&
                    now - callback.createdAt > options.initialHeartbeatTimeoutMs
                ) {
                    logger.warn(`No active client heartbeat for ${toolCallbackId} (requestId: ${requestId})`);
                    callback.reject(
                        new Error(
                            `CLIENT_TOOL_HEARTBEAT_TIMEOUT: no client heartbeat within ${options.initialHeartbeatTimeoutMs}ms. ${CLIENT_TOOL_HEARTBEAT_TIMEOUT_GUIDANCE}`
                        )
                    );
                    return;
                }

                if (
                    callback.lastHeartbeatAt &&
                    now - callback.lastHeartbeatAt > options.heartbeatStaleMs
                ) {
                    logger.warn(`Client tool heartbeat stopped for ${toolCallbackId} (requestId: ${requestId})`);
                    callback.reject(
                        new Error(
                            `CLIENT_TOOL_HEARTBEAT_TIMEOUT: no client heartbeat for ${options.heartbeatStaleMs}ms. ${CLIENT_TOOL_HEARTBEAT_TIMEOUT_GUIDANCE}`
                        )
                    );
                }
            }, options.checkEveryMs);
        }

        // Store the callback
        pendingCallbacks.set(toolCallbackId, {
            resolve: (result) => {
                const callback = pendingCallbacks.get(toolCallbackId);
                callback && cleanupCallback(toolCallbackId, callback);
                resolve(result);
            },
            reject: (error) => {
                const callback = pendingCallbacks.get(toolCallbackId);
                callback && cleanupCallback(toolCallbackId, callback);
                reject(error);
            },
            timeout,
            heartbeatInterval,
            requestId,
            createdAt,
            lastHeartbeatAt: null,
            heartbeatCount: 0,
        });

        logger.info(`Registered client tool callback: ${toolCallbackId} (requestId: ${requestId})`);
    });
}

/**
 * Resolve a pending client tool callback locally (internal use)
 * @param {string} toolCallbackId - The tool callback ID
 * @param {object} result - The result from the client
 * @returns {boolean} True if callback was found and resolved
 */
function resolveClientToolCallbackLocal(toolCallbackId, result) {
    const callback = pendingCallbacks.get(toolCallbackId);
    
    if (!callback) {
        // This is normal in a multi-instance setup - the callback might be on another instance
        logger.debug(`No pending callback found for toolCallbackId: ${toolCallbackId} (may be on another instance)`);
        return false;
    }

    logger.info(`Resolved client tool callback: ${toolCallbackId} (requestId: ${callback.requestId})`);
    
    // Resolve the promise
    callback.resolve(result);
    
    return true;
}

/**
 * Resolve a pending client tool callback with the result
 * This function publishes to Redis so all instances can attempt to resolve
 * @param {string} toolCallbackId - The tool callback ID
 * @param {object} result - The result from the client
 * @returns {Promise<boolean>} True if callback was published/resolved
 */
export async function resolveClientToolCallback(toolCallbackId, result) {
    if (publisherClient) {
        // Publish to Redis so all instances can try to resolve
        try {
            const message = JSON.stringify({ toolCallbackId, result });
            logger.debug(`Publishing client tool callback to Redis: ${toolCallbackId}`);
            await publisherClient.publish(clientToolCallbackChannel, message);
            return true;
        } catch (error) {
            logger.error(`Error publishing client tool callback to Redis: ${error}`);
            // Fall back to local resolution
            return resolveClientToolCallbackLocal(toolCallbackId, result);
        }
    } else {
        // No Redis, resolve locally
        return resolveClientToolCallbackLocal(toolCallbackId, result);
    }
}

/**
 * Reject a pending client tool callback locally (internal use)
 * @param {string} toolCallbackId - The tool callback ID
 * @param {Error} error - The error
 * @returns {boolean} True if callback was found and rejected
 */
function rejectClientToolCallbackLocal(toolCallbackId, error) {
    const callback = pendingCallbacks.get(toolCallbackId);
    
    if (!callback) {
        logger.debug(`No pending callback found for toolCallbackId: ${toolCallbackId} (may be on another instance)`);
        return false;
    }

    logger.info(`Rejected client tool callback: ${toolCallbackId} (requestId: ${callback.requestId})`);
    
    // Reject the promise
    callback.reject(error);
    
    return true;
}

function recordClientToolHeartbeatLocal(toolCallbackId, requestId, ts = Date.now()) {
    const callback = pendingCallbacks.get(toolCallbackId);

    if (!callback) {
        logger.debug(`No pending callback found for heartbeat toolCallbackId: ${toolCallbackId} (requestId: ${requestId || 'unknown'})`);
        return false;
    }

    callback.lastHeartbeatAt = Number.isFinite(ts) ? ts : Date.now();
    callback.heartbeatCount = (callback.heartbeatCount || 0) + 1;
    return true;
}

export async function recordClientToolHeartbeat(toolCallbackId, requestId) {
    if (publisherClient) {
        try {
            const message = JSON.stringify({ toolCallbackId, requestId, ts: Date.now() });
            await publisherClient.publish(clientToolHeartbeatChannel, message);
            return true;
        } catch (error) {
            logger.error(`Error publishing client tool heartbeat to Redis: ${error}`);
            return recordClientToolHeartbeatLocal(toolCallbackId, requestId);
        }
    }

    return recordClientToolHeartbeatLocal(toolCallbackId, requestId);
}

/**
 * Reject a pending client tool callback with an error
 * This function publishes to Redis so all instances can attempt to reject
 * @param {string} toolCallbackId - The tool callback ID
 * @param {Error} error - The error
 * @returns {Promise<boolean>} True if callback was published/rejected
 */
export async function rejectClientToolCallback(toolCallbackId, error) {
    if (publisherClient) {
        // Publish to Redis so all instances can try to reject
        try {
            const message = JSON.stringify({ 
                toolCallbackId, 
                result: { success: false, error: error.message || error.toString() } 
            });
            logger.debug(`Publishing client tool callback rejection to Redis: ${toolCallbackId}`);
            await publisherClient.publish(clientToolCallbackChannel, message);
            return true;
        } catch (publishError) {
            logger.error(`Error publishing client tool callback rejection to Redis: ${publishError}`);
            // Fall back to local rejection
            return rejectClientToolCallbackLocal(toolCallbackId, error);
        }
    } else {
        // No Redis, reject locally
        return rejectClientToolCallbackLocal(toolCallbackId, error);
    }
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
            cleanupCallback(id, callback);
            callback.reject(new Error('Callback expired during cleanup'));
            cleaned++;
        }
    }
    
    if (cleaned > 0) {
        logger.info(`Cleaned up ${cleaned} old client tool callbacks`);
    }
    
    return cleaned;
}
