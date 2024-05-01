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

// Function to get all key value pairs in "FileStoreMap" hash map
const getAllFileStoreMap = async () => {
    try {
        const allKeyValuePairs = await client.hgetall("FileStoreMap");
        // Parse each JSON value in the returned object
        for (const key in allKeyValuePairs) {
            try {
                // Modify the value directly in the returned object
                allKeyValuePairs[key] = JSON.parse(allKeyValuePairs[key]);
            } catch (error) {
                console.error(`Error parsing JSON for key ${key}: ${error}`);
                // keep original value if parsing failed
            }
        }
        return allKeyValuePairs;
    } catch (error) {
        console.error(`Error getting all key-value pairs from FileStoreMap: ${error}`);
        return {}; // Return null or any default value indicating an error occurred
    }
};

// Function to set key value in "FileStoreMap" hash map
const setFileStoreMap = async (key, value) => {
    try {
        value.timestamp = new Date().toISOString();
        await client.hset("FileStoreMap", key, JSON.stringify(value));
    } catch (error) {
        console.error(`Error setting key in FileStoreMap: ${error}`);
    }
};

const getFileStoreMap = async (key) => {
    try {
        const value = await client.hget("FileStoreMap", key);
        if (value) {
            try {
                // parse the value back to an object before returning
                return JSON.parse(value);
            } catch (error) {
                console.error(`Error parsing JSON: ${error}`);
                return value; // return original value if parsing failed
            }
        }
        return value;
    } catch (error) {
        console.error(`Error getting key from FileStoreMap: ${error}`);
        return null; // Return null or any default value indicating an error occurred
    }
};

// Function to remove key from "FileStoreMap" hash map
const removeFromFileStoreMap = async (key) => {
    try {
        // hdel returns the number of keys that were removed.
        // If the key does not exist, 0 is returned.
        const result = await client.hdel("FileStoreMap", key);
        if (result === 0) {
            console.log(`The key ${key} does not exist`);
        } else {
            console.log(`The key ${key} was removed successfully`);
        }
    } catch (error) {
        console.error(`Error removing key from FileStoreMap: ${error}`);
    }
};

const cleanupRedisFileStoreMap = async (nDays=1) => {
    let cleaned = [];
    try {
        // Get all key-value pairs from "FileStoreMap"
        const fileStoreMap = await getAllFileStoreMap();

        if(!fileStoreMap){
            console.log("FileStoreMap is empty");
            return;
        }
        
        // Iterate over each key-value pair in the fileStoreMap
        for (const [key, value] of Object.entries(fileStoreMap)) {
            //check timestamp of each value compare to nDays and remove if older
            const timestamp = new Date(value.timestamp);
            const now = new Date();
            const diffTime = Math.abs(now - timestamp);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
            if (diffDays > nDays) {
                // Remove the key from the "FileStoreMap" hash map
                await removeFromFileStoreMap(key);
                console.log(`Removed key ${key} from FileStoreMap`);
                cleaned.push(Object.assign({hash:key}, value));
            }

        }
    } catch (error) {
        console.error(`Error cleaning FileStoreMap: ${error}`);
    }finally{
        return cleaned;
    }
};


export {
    publishRequestProgress, connectClient, setFileStoreMap, getFileStoreMap, removeFromFileStoreMap, cleanupRedisFileStoreMap
};