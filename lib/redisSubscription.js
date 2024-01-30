import Redis from 'ioredis';
import { config } from '../config.js';
import pubsub from '../server/pubsub.js';

const connectionString = config.get('storageConnectionString');
const channel = 'requestProgress';
let client;

if (connectionString) {
    console.log(`Using Redis subscription for channel ${channel}`);
    try {
        client = connectionString && new Redis(connectionString);
    } catch (error) {
        console.error('Redis connection error: ', error);
    }

    if (client) {
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

                pubsubHandleMessage(parsedMessage);
            }
        });

    }
}


let publisherClient;
if (connectionString){  
    console.log(`Using Redis publish for channel ${channel}`);
    publisherClient = Redis.createClient(connectionString);
}else{
    console.log(`Using pubsub publish for channel ${channel}`);
}

async function publishRequestProgress(data){
    if(publisherClient){
        try {
            const message = JSON.stringify(data);
            console.log(`Publishing message ${message} to channel ${channel}`);
            await publisherClient.publish(channel, message);
        } catch (error) {
            console.error(`Error publishing message: ${error}`);
        }
    }else{
        pubsubHandleMessage(data);
    }
}

function pubsubHandleMessage(data){
    // Process the received data
    console.log('Processing data:', data);
    try {
        pubsub.publish('REQUEST_PROGRESS', { requestProgress: data });
    } catch (error) {
        console.error(`Error publishing data to pubsub: ${error}`);
    }
};

export {
    client as subscriptionClient, publishRequestProgress
};