// clientToolCallbacks.js
// Storage and management for pending client-side tool callbacks

import logger from '../lib/logger.js';
import Redis from 'ioredis';
import { config } from '../config.js';

// Map to store pending client tool callbacks
// Key: toolCallbackId, Value: { resolve, reject, timeout, requestId }
const pendingCallbacks = new Map();

// Default timeout for client tool responses (5 minutes)
// Increased from 60s to 5min to accommodate longer operations like CreateApplet
const DEFAULT_TIMEOUT = 300000;

// Redis setup for cross-instance communication
const connectionString = config.get('storageConnectionString');
const clientToolCallbackChannel = 'clientToolCallbacks';

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
            subscriptionClient.subscribe(clientToolCallbackChannel, (error) => {
                if (error) {
                    logger.error(`Error subscribing to Redis channel ${clientToolCallbackChannel}: ${error}`);
                } else {
                    logger.info(`Subscribed to client tool callback channel: ${clientToolCallbackChannel}`);
                }
            });
        });
        
        subscriptionClient.on('message', (channel, message) => {
            if (channel === clientToolCallbackChannel) {
                try {
                    const { toolCallbackId, result } = JSON.parse(message);
                    logger.debug(`Received client tool callback via Redis: ${toolCallbackId}`);
                    
                    // Try to resolve it locally (will only work if this instance has the pending callback)
                    resolveClientToolCallbackLocal(toolCallbackId, result);
                } catch (error) {
                    logger.error(`Error processing client tool callback from Redis: ${error}`);
                }
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

