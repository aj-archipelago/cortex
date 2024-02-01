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
                        logger.error(`Error subscribing to redis channel ${channel}: ${error}`);
                    } else {
                        logger.info(`Subscribed to channel ${channel}`);
                    }
                });
            });
        });

        subscriptionClient.on('message', (channel, message) => {
            logger.debug(`Received message from ${channel}: ${message}`);
            
            let decryptedMessage = message;

            if (channel === requestProgressChannel && redisEncryptionKey) {
                try {
                    decryptedMessage = decrypt(message, redisEncryptionKey);
                } catch (error) {
                    logger.error(`Error decrypting message: ${error}`);
                }
            }

            let parsedMessage = decryptedMessage;
            try {
                parsedMessage = JSON.parse(decryptedMessage);
            } catch (error) {
                logger.error(`Error parsing message: ${error}`);
            }

            switch(channel) {
                case requestProgressChannel:
                    pubsubHandleMessage(parsedMessage);
                    break;
                case requestProgressSubscriptionsChannel:
                    handleSubscription(parsedMessage);
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
    if (publisherClient) {
        try {
            let message = JSON.stringify(data);
            if (redisEncryptionKey) {
                try {
                    message = encrypt(message, redisEncryptionKey);
                } catch (error) {
                    logger.error(`Error encrypting message: ${error}`);
                }
            }
            logger.debug(`Publishing message ${message} to channel ${requestProgressChannel}`);
            await publisherClient.publish(requestProgressChannel, message);
        } catch (error) {
            logger.error(`Error publishing message: ${error}`);
        }
    } else {
        pubsubHandleMessage(data);
    }
}

async function publishRequestProgressSubscription(data) {
    if (publisherClient) {
        try {
            const message = JSON.stringify(data);
            logger.debug(`Publishing message ${message} to channel ${requestProgressSubscriptionsChannel}`);
            await publisherClient.publish(requestProgressSubscriptionsChannel, message);
        } catch (error) {
            logger.error(`Error publishing message: ${error}`);
        }
    } else {
        handleSubscription(data);
    }
}

function pubsubHandleMessage(data){
    const message = JSON.stringify(data);
    logger.debug(`Publishing message to pubsub: ${message}`);
    try {
        pubsub.publish('REQUEST_PROGRESS', { requestProgress: data });
    } catch (error) {
        logger.error(`Error publishing data to pubsub: ${error}`);
    }
}

function handleSubscription(data){
    const requestIds = data;
    for (const requestId of requestIds) {
        if (requestState[requestId] && !requestState[requestId].started) {
            requestState[requestId].started = true;
            logger.info(`Subscription starting async requestProgress, requestId: ${requestId}`);
            const { resolver, args } = requestState[requestId];
            resolver(args);
        }
    }
}

export {
    subscriptionClient, publishRequestProgress, publishRequestProgressSubscription
};