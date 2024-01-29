import Redis from 'ioredis';
import { config } from '../config.js';
import pubsub from '../server/pubsub.js';
import logger from '../lib/logger.js';

const connectionString = config.get('storageConnectionString');
const channel = 'requestProgress';
let client;

if (connectionString) {
    logger.info(`Using Redis subscription for channel ${channel}`);
    try {
        client = connectionString && new Redis(connectionString);
    } catch (error) {
        logger.error(`Redis connection error: ${error}`);
    }

    if (client) {
        const channel = 'requestProgress';

        client.on('error', (error) => {
            logger.error(`Redis client error: ${error}`);
        });

        client.on('connect', () => {
            client.subscribe(channel, (error) => {
                if (error) {
                    logger.error(`Error subscribing to channel ${channel}: ${error}`);
                } else {
                    logger.info(`Subscribed to channel ${channel}`);
                }
            });
        });

        client.on('message', (channel, message) => {
            if (channel === 'requestProgress') {
                logger.info(`Received message from ${channel}: ${message}`);
                let parsedMessage;

                try {
                    parsedMessage = JSON.parse(message);
                } catch (error) {
                    parsedMessage = message;
                }

                handleMessage(parsedMessage);
            }
        });

        const handleMessage = (data) => {
            // Process the received data
            logger.info(`Processing data: ${data}`);
            try {
                pubsub.publish('REQUEST_PROGRESS', { requestProgress: data });
            } catch (error) {
                logger.error(`Error publishing data to pubsub: ${error}`);
            }
        };
    }
}

export {
    client as subscriptionClient,
};