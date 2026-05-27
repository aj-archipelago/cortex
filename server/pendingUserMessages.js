// pendingUserMessages.js
// Queue for user messages injected into running agent loops.
// Uses Redis pub/sub for cross-instance delivery (same pattern as clientToolCallbacks.js).
// The local in-memory queue is populated by the Redis subscriber; the agent loop drains it.

import logger from '../lib/logger.js';
import Redis from 'ioredis';
import { config } from '../config.js';
import { requestState } from './requestState.js';
import { publishRequestProgress } from '../lib/redisSubscription.js';

// Local queue — only contains messages for requests running on THIS instance
// Map<requestId, Array<{ message: string, timestamp: number }>>
const pendingMessages = new Map();

// Redis pub/sub for cross-instance routing
const connectionString = config.get('storageConnectionString');
const channel = 'pendingUserMessages';

let subscriptionClient;
let publisherClient;

if (connectionString) {
    logger.info(`Setting up Redis pub/sub for user message injection on channel: ${channel}`);

    try {
        subscriptionClient = new Redis(connectionString);
        subscriptionClient.on('error', (error) => {
            logger.error(`Redis subscriptionClient error (pendingUserMessages): ${error}`);
        });

        subscriptionClient.on('connect', () => {
            subscriptionClient.subscribe(channel, (error) => {
                if (error) {
                    logger.error(`Error subscribing to Redis channel ${channel}: ${error}`);
                } else {
                    logger.info(`Subscribed to pending user messages channel: ${channel}`);
                }
            });
        });

        subscriptionClient.on('message', (ch, message) => {
            if (ch === channel) {
                try {
                    const { requestId, userMessage } = JSON.parse(message);
                    // Only queue locally if this instance owns the request
                    if (requestState[requestId]) {
                        queueLocalMessage(requestId, userMessage);
                    }
                } catch (error) {
                    logger.error(`Error processing pending user message from Redis: ${error}`);
                }
            }
        });
    } catch (error) {
        logger.error(`Redis connection error (pendingUserMessages): ${error}`);
    }

    try {
        publisherClient = new Redis(connectionString);
        publisherClient.on('error', (error) => {
            logger.error(`Redis publisherClient error (pendingUserMessages): ${error}`);
        });
    } catch (error) {
        logger.error(`Redis connection error (pendingUserMessages publisher): ${error}`);
    }
}

/**
 * Add a message to the local in-memory queue directly (bypasses Redis).
 * Exported for unit testing and for the Redis subscriber.
 */
export function queueLocalMessage(requestId, message) {
    if (!requestId || !message) return false;

    if (!pendingMessages.has(requestId)) {
        pendingMessages.set(requestId, []);
    }

    const timestamp = Date.now();

    pendingMessages.get(requestId).push({
        message,
        timestamp,
    });

    logger.info(`Queued user message for request ${requestId} (queue size: ${pendingMessages.get(requestId).length})`);

    // Emit a synthetic toolMessage on the request's progress stream so the
    // client can render the injected message inline without optimistic insertion.
    publishRequestProgress({
        requestId,
        progress: 0.5,
        data: JSON.stringify(""),
        info: JSON.stringify({
            toolMessage: {
                type: 'start',
                callId: `inject-${timestamp}`,
                icon: '💬',
                userMessage: message,
                presentation: 'inline_user',
            }
        }),
    });

    return true;
}

/**
 * Queue a user message for injection into a running request's agent loop.
 * Publishes to Redis so all instances receive it; the instance owning the
 * requestId will queue it locally.
 * @param {string} requestId
 * @param {string} message
 * @returns {Promise<boolean>}
 */
export async function queueUserMessage(requestId, message) {
    if (!requestId || !message) return false;

    if (publisherClient) {
        try {
            await publisherClient.publish(channel, JSON.stringify({ requestId, userMessage: message }));
            logger.info(`Published user message to Redis for request ${requestId}`);
            return true;
        } catch (error) {
            logger.error(`Error publishing user message to Redis: ${error}`);
            // Fall back to local queue (works if request is on this instance)
            return queueLocalMessage(requestId, message);
        }
    } else {
        // No Redis — queue locally (single-instance mode)
        return queueLocalMessage(requestId, message);
    }
}

/**
 * Drain all pending messages for a request (returns and removes them).
 * Called by the agent loop before each model call.
 * @param {string} requestId
 * @returns {Array<{ message: string, timestamp: number }>}
 */
export function drainPendingMessages(requestId) {
    if (!requestId || !pendingMessages.has(requestId)) return [];

    const messages = pendingMessages.get(requestId);
    pendingMessages.delete(requestId);

    if (messages.length > 0) {
        logger.info(`Drained ${messages.length} pending user message(s) for request ${requestId}`);
    }
    return messages;
}

/**
 * Check if any messages are pending (non-destructive).
 * @param {string} requestId
 * @returns {boolean}
 */
export function hasPendingMessages(requestId) {
    if (!requestId) return false;
    const queue = pendingMessages.get(requestId);
    return queue != null && queue.length > 0;
}

/**
 * Clean up pending messages for a completed/canceled request.
 * @param {string} requestId
 */
export function clearPendingMessages(requestId) {
    pendingMessages.delete(requestId);
}
