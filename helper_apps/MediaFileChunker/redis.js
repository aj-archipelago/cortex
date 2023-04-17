import redis from 'ioredis';
const connectionString = process.env["REDIS_CONNECTION_STRING"];
const client = redis.createClient(connectionString);
// client.connect();

const channel = 'requestProgress';

const connectClient = async () => {
    if (!client.connected) {
        try {
            await client.connect();
        } catch (error) {
            console.error(`Error reconnecting to Redis: ${error}`);
            return;
        }
    }
};

const publishRequestProgress = async (data) => {
    // await connectClient();
    try {
        const message = JSON.stringify(data);
        console.log(`Publishing message ${message} to channel ${channel}`);
        await client.publish(channel, message);
    } catch (error) {
        console.error(`Error publishing message: ${error}`);
    }
};

export {
    publishRequestProgress, connectClient
}