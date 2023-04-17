import Redis from 'ioredis';
import { config } from '../config.js';
import pubsub from '../graphql/pubsub.js';

const connectionString = config.get('storageConnectionString');
const client = new Redis(connectionString);

const channel = 'requestProgress';

client.on('error', (error) => {
    console.error(`Redis client error: ${error}`);
});

client.on('connect', () => {
    client.subscribe(channel, (error) => {
        if (error) {
            console.error(`Error subscribing to channel ${channel}: ${error}`);
        } else {
            console.log(`Subscribed to channel ${channel}`);
        }
    });
});

client.on('message', (channel, message) => {
    if (channel === 'requestProgress') {
        console.log(`Received message from ${channel}: ${message}`);
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
    console.log('Processing data:', data);
    try {
        pubsub.publish('REQUEST_PROGRESS', { requestProgress: data });
    } catch (error) {
        console.error(`Error publishing data to pubsub: ${error}`);
    }
};

export {
    client as subscriptionClient,
};