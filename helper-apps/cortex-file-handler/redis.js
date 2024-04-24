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

const cleanupRedisFileStoreMap = async (cleanedUrls) => {
    try {
        if(!cleanedUrls || cleanedUrls.length === 0) {
            return;
        }
        // Convert cleanedUrls array to a Set for quick lookup
        const cleanedUrlSet = new Set(cleanedUrls);

        try{
            cleanedUrls.map(url => {
                cleanedUrlSet.add(url.split('/').slice(-2).join('/'));
            });
        }catch(error){
            console.error(`Error adding cleaned urls to cleanedUrlSet: ${error}`);
        }
        
        // Get all key-value pairs from "FileStoreMap"
        const fileStoreMap = await getAllFileStoreMap();
        
        // Iterate over each key-value pair in the fileStoreMap
        for (const [key, value] of Object.entries(fileStoreMap)) {
            // Check if the url of the value is in the cleanedUrlSet
            if(value.url){
                const urlEndPart = value.url.split('/').slice(-2).join('/');

                if (cleanedUrlSet.has(value.url) || cleanedUrlSet.has(urlEndPart) ) {
                    // Delete the key from "FileStoreMap"
                    await removeFromFileStoreMap(key);
                    console.log(`Cleaned FileStoreMap key: ${key} with url: ${value.url}`);
                }
            }
        }
    } catch (error) {
        console.error(`Error cleaning FileStoreMap: ${error}`);
    }
};


export {
    publishRequestProgress, connectClient, setFileStoreMap, getFileStoreMap, removeFromFileStoreMap, cleanupRedisFileStoreMap
};