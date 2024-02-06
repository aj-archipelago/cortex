import Redis from 'ioredis';
import { config } from '../config.js';
import pubsub from '../server/pubsub.js';
import { requestState } from '../server/requestState.js';
import logger from '../lib/logger.js';
import { encrypt, decrypt } from '../lib/crypto.js';

const connectionString = config.get('storageConnectionString');
const redisEncryptionKey = config.get('redisEncryptionKey');
const requestProgressChannel = 'requestProgress';
const requestProgressSubscriptionsChannel = 'requestProgressSubscriptions';

let subscriptionClient;
let publisherClient;

if (connectionString) {
    logger.info(`Using Redis subscription for channel(s) ${requestProgressChannel}, ${requestProgressSubscriptionsChannel}`);
    try {
        subscriptionClient = connectionString && new Redis(connectionString);
    } catch (error) {
        logger.error(`Redis connection error: ${error}`);
    }

    logger.info(`Using Redis publish for channel(s) ${requestProgressChannel}, ${requestProgressSubscriptionsChannel}`);
    try {
        publisherClient = connectionString && new Redis(connectionString);
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
            const channels = [requestProgressChannel, requestProgressSubscriptionsChannel];

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
                case requestProgressChannel:
                    parsedMessage && pubsubHandleMessage(parsedMessage);
                    break;
                case requestProgressSubscriptionsChannel:
                    parsedMessage && handleSubscription(parsedMessage);
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

async function publishRequestProgress(data) {
    if (publisherClient && requestState?.[data?.requestId]?.useRedis) {
        try {
            let message = JSON.stringify(data);
            if (redisEncryptionKey) {
                try {
                    message = encrypt(message, redisEncryptionKey);
                } catch (error) {
                    logger.error(`Error encrypting message: ${error}`);
                }
            }
            logger.debug(`Publishing request progress ${message} to Redis channel ${requestProgressChannel}`);
            await publisherClient.publish(requestProgressChannel, message);
        } catch (error) {
            logger.error(`Error publishing request progress to Redis: ${error}`);
        }
    } else {
        pubsubHandleMessage(data);
    }
}

async function publishRequestProgressSubscription(data) {
    if (publisherClient) {
        try {
            const requestIds = data;
            const idsToForward = [];
            // If any of these requests belong to this instance, we can just start and handle them locally
            for (const requestId of requestIds) {
                if (requestState[requestId]) {
                    if (!requestState[requestId].started) {
                        requestState[requestId].started = true;
                        requestState[requestId].useRedis = false;
                        logger.info(`Starting local execution for registered async request: ${requestId}`);
                        const { resolver, args } = requestState[requestId];
                        resolver(args, false);
                    }
                } else {
                    idsToForward.push(requestId);
                }
            }

            if (idsToForward.length > 0) {
                const message = JSON.stringify(idsToForward);
                logger.debug(`Sending subscription request(s) to channel ${requestProgressSubscriptionsChannel} for remote execution: ${message}`);
                await publisherClient.publish(requestProgressSubscriptionsChannel, message);
            }
        } catch (error) {
            logger.error(`Error handling subscription: ${error}`);
        }
    } else {
        handleSubscription(data);
    }
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

function handleSubscription(data){
    const requestIds = data;
    for (const requestId of requestIds) {
        if (requestState[requestId] && !requestState[requestId].started) {
            requestState[requestId].started = true;
            requestState[requestId].useRedis = true;
            logger.info(`Starting execution for registered async request: ${requestId}`);
            const { resolver, args } = requestState[requestId];
            resolver(args);
        }
    }
}

export {
    subscriptionClient, publishRequestProgress, publishRequestProgressSubscription
};