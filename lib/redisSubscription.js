import Redis from 'ioredis';
import { config } from '../config.js';
import pubsub from '../server/pubsub.js';
import { requestState } from '../server/requestState.js';
import logger from '../lib/logger.js';

const connectionString = config.get('storageConnectionString');
const channels = ['requestProgress', 'requestProgressSubscriptions'];
let client;

if (connectionString) {
    logger.info(`Using Redis subscription for channel(s) ${channels.join(', ')}`);
    try {
        client = connectionString && new Redis(connectionString);
    } catch (error) {
        logger.error(`Redis connection error: ${JSON.stringify(error)}`);
    }

    if (client) {

        client.on('error', (error) => {
            logger.error(`Redis client error: ${JSON.stringify(error)}`);
        });

        client.on('connect', () => {
            client.subscribe('requestProgress', (error) => {
                if (error) {
                    logger.error(`Error subscribing to redis channel requestProgress: ${JSON.stringify(error)}`);
                } else {
                    logger.info(`Subscribed to channel requestProgress`);
                }
            });
            client.subscribe('requestProgressSubscriptions', (error) => {
                if (error) {
                    logger.error(`Error subscribing to redis channel requestProgressSubscriptions: ${JSON.stringify(error)}`);
                } else {
                    logger.info(`Subscribed to channel requestProgressSubscriptions`);
                }
            });
        });

        client.on('message', (channel, message) => {
            if (channel === 'requestProgress') {
                logger.debug(`Received message from ${channel}: ${message}`);
                let parsedMessage;

                try {
                    parsedMessage = JSON.parse(message);
                } catch (error) {
                    parsedMessage = message;
                }

                pubsubHandleMessage(parsedMessage);
            } else {
                if (channel === 'requestProgressSubscriptions') {
                    logger.debug(`Received message from ${channel}: ${message}`);
                    let parsedMessage;

                    try {
                        parsedMessage = JSON.parse(message);
                    } catch (error) {
                        parsedMessage = message;
                    }

                    handleSubscription(parsedMessage);
                }
            }
        });
    }
}


let publisherClient;

if (connectionString) {
    logger.info(`Using Redis publish for channel(s) ${channels.join(', ')}`);
    publisherClient = Redis.createClient(connectionString);
} else {
    logger.info(`Using pubsub publish for channel ${channels[0]}`);
}

async function publishRequestProgress(data) {
    if (publisherClient) {
        try {
            const message = JSON.stringify(data);
            logger.debug(`Publishing message ${message} to channel ${channels[0]}`);
            await publisherClient.publish(channels[0], message);
        } catch (error) {
            logger.error(`Error publishing message: ${JSON.stringify(error)}`);
        }
    } else {
        pubsubHandleMessage(data);
    }
}

async function publishRequestProgressSubscription(data) {
    if (publisherClient) {
        try {
            const message = JSON.stringify(data);
            logger.debug(`Publishing message ${message} to channel ${channels[1]}`);
            await publisherClient.publish(channels[1], message);
        } catch (error) {
            logger.error(`Error publishing message: ${JSON.stringify(error)}`);
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
        logger.error(`Error publishing data to pubsub: ${JSON.stringify(error)}`);
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
    client as subscriptionClient, publishRequestProgress, publishRequestProgressSubscription
};