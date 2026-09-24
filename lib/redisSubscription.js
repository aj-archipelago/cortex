import { cancelLocalRequest, clearRequestDeadline } from '../server/requestCancellation.js';
import Redis from 'ioredis';
import { createRequestProgressRouter } from './requestProgressRouter.js';
import { config } from '../config.js';
import pubsub from '../server/pubsub.js';
import { requestState } from '../server/requestState.js';
import logger from '../lib/logger.js';
import { encrypt, decrypt } from '../lib/crypto.js';

const connectionString = config.get('storageConnectionString');
const redisEncryptionKey = config.get('redisEncryptionKey');
const requestCancellationChannel = 'requestCancellation';
const requestProgressChannel = 'requestProgress';
const requestProgressSubscriptionsChannel = 'requestProgressSubscriptions';

let subscriptionClient;
let publisherClient;

if (connectionString) {
    // Configure Redis with exponential backoff retry strategy
    const retryStrategy = (times) => {
        // Exponential backoff: 100ms, 200ms, 400ms, 800ms, 1600ms, 3200ms, 6400ms, 12800ms, 25600ms, 30000ms (max)
        const delay = Math.min(100 * Math.pow(2, times), 30000);
        // Stop retrying after 10 attempts (about 5 minutes total)
        if (times > 10) {
            logger.error(`Redis connection failed after ${times} attempts. Stopping retries.`);
            return null;
        }
        logger.warn(`Redis connection retry attempt ${times}, waiting ${delay}ms before next attempt`);
        return delay;
    };

    const redisOptions = {
        retryStrategy,
        maxRetriesPerRequest: null, // Allow unlimited retries for connection issues
        enableReadyCheck: true,
        lazyConnect: false,
        connectTimeout: 10000, // 10 second connection timeout
    };

    logger.info(`Using Redis subscription for channel(s) ${requestProgressChannel}, ${requestProgressSubscriptionsChannel}`);
    try {
        subscriptionClient = new Redis(connectionString, redisOptions);
        if (subscriptionClient) {
            subscriptionClient.on('connect', () => {
                logger.info('Redis subscription client connected successfully');
            });
            subscriptionClient.on('ready', () => {
                logger.info('Redis subscription client ready');
            });
            subscriptionClient.on('reconnecting', (delay) => {
                logger.info(`Redis subscription client reconnecting in ${delay}ms`);
            });
        }
    } catch (error) {
        logger.error(`Redis connection error: ${error}`);
    }

    logger.info(`Using Redis publish for channel(s) ${requestProgressChannel}, ${requestProgressSubscriptionsChannel}`);
    try {
        publisherClient = connectionString && new Redis(connectionString, redisOptions);
        // Handle Redis publisher client errors to prevent crashes
        if (publisherClient) {
            publisherClient.on('error', (error) => {
                logger.error(`Redis publisherClient error: ${error}`);
            });
            publisherClient.on('connect', () => {
                logger.info('Redis publisher client connected successfully');
            });
            publisherClient.on('ready', () => {
                logger.info('Redis publisher client ready');
            });
            publisherClient.on('reconnecting', (delay) => {
                logger.info(`Redis publisher client reconnecting in ${delay}ms`);
            });
        }
    } catch (error) {
        logger.error(`Redis connection error: ${error}`);
    }

    if (redisEncryptionKey) {
        logger.info('Using encryption for Redis');
    } else {
        logger.warn('REDIS_ENCRYPTION_KEY not set. Data stored in Redis will not be encrypted.');
    }

    if (subscriptionClient) {

        subscriptionClient.on('error', (error) => {
            logger.error(`Redis subscriptionClient error: ${error}`);
        });

        subscriptionClient.on('connect', () => {
            const channels = [requestProgressChannel, requestProgressSubscriptionsChannel, requestCancellationChannel];

            channels.forEach(channel => {
                subscriptionClient.subscribe(channel, (error) => {
                    if (error) {
                        logger.error(`Error subscribing to Redis channel ${channel}: ${error}`);
                    } else {
                        logger.info(`Subscribed to channel ${channel}`);
                    }
                });
            });
        });

        subscriptionClient.on('message', (channel, message) => {
            logger.debug(`Received message from Redis channel ${channel}: ${message}`);

            let parsedMessage;

            try {
                parsedMessage = JSON.parse(message);
            } catch (error) {
                if (channel === requestProgressChannel && redisEncryptionKey) {
                    try {
                        parsedMessage = JSON.parse(decrypt(message, redisEncryptionKey));
                    } catch (error) {
                        logger.error(`Error parsing or decrypting message: ${error}`);
                    }
                } else {
                    logger.error(`Error parsing message: ${error}`);
                }
            }

            switch(channel) {
                case requestCancellationChannel:
                    if (typeof parsedMessage?.requestId === 'string') cancelLocalRequest(parsedMessage.requestId);
                    break;
                case requestProgressChannel:
                    parsedMessage && pubsubHandleMessage(parsedMessage);
                    break;
                case requestProgressSubscriptionsChannel:
                    if (parsedMessage) void handleSubscription(parsedMessage).catch(error => logger.error(`Error handling subscription: ${error}`));
                    break;
                default:
                    logger.error(`Unsupported channel: ${channel}`);
                    break;
            }
        });
    }
} else {
    // No Redis connection, use pubsub for communication
    logger.info(`Using pubsub publish for channel ${requestProgressChannel}`);
}

const { publishRequestProgress: publishRoutedProgress, publishRequestProgressSubscription, handleSubscription } = createRequestProgressRouter({
    requestState,
    startRequest: (id, state, remote) => startRegisteredRequest(id, state.resolver, state.args, remote),
    publishLocal: pubsubHandleMessage,
    publishRemote: publisherClient ? async (data) => {
        try {
            const plain = JSON.stringify(data);
            const message = redisEncryptionKey ? encrypt(plain, redisEncryptionKey) : plain;
            await publisherClient.publish(requestProgressChannel, message);
        } catch (error) {
            logger.error(`Error publishing request progress to Redis: ${error}`);
            pubsubHandleMessage(data);
        }
    } : null,
    forwardSubscriptions: publisherClient ? async (ids) => {
        await publisherClient.publish(requestProgressSubscriptionsChannel, JSON.stringify(ids));
    } : null,
});

async function publishRequestProgress(data) {
    if (data?.progress === 1) clearRequestDeadline(data.requestId);
    return publishRoutedProgress(data);
}

function pubsubHandleMessage(data){
    const message = JSON.stringify(data);
    logger.debug(`Publishing request progress to local subscribers: ${message}`);
    try {
        pubsub.publish('REQUEST_PROGRESS', { requestProgress: data });
    } catch (error) {
        logger.error(`Error publishing request progress to local subscribers: ${error}`);
    }
}

export {
    subscriptionClient, publishRequestProgress, publishRequestProgressSubscription, publishRequestCancellation
};
// Cancellation must reach the instance running the request, independently of
// which instance receives the GraphQL mutation. No work is started by this path.
async function publishRequestCancellation(requestId) {
    if (publisherClient) {
        await publisherClient.set(`requestCancelled:${requestId}`, '1', 'EX', 3600);
        await publisherClient.publish(requestCancellationChannel, JSON.stringify({ requestId }));
    }
}

async function startRegisteredRequest(requestId, resolver, args, local) {
    if (requestState[requestId]?.deadline && publisherClient) {
        if (await publisherClient.get(`requestCancelled:${requestId}`)) cancelLocalRequest(requestId);
    }
    if (resolver) void resolver(args, local);
}
