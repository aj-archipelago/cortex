import Keyv from 'keyv';
import { config } from '../config.js';
import { encrypt, decrypt } from './crypto.js';
import logger from './logger.js';

const storageConnectionString = config.get('storageConnectionString');
const cortexId = config.get('cortexId');
const redisEncryptionKey = config.get('redisEncryptionKey');

// Create a keyv client to store data
const keyValueStorageClient = new Keyv(storageConnectionString, {
    ssl: true,
    abortConnect: false,
    serialize: (data) => redisEncryptionKey ? encrypt(JSON.stringify(data), redisEncryptionKey) : JSON.stringify(data),
    deserialize: (data) => {
        try {
            // Try to parse the data normally
            return JSON.parse(data);
        } catch (error) {
            // If it fails, the data may be encrypted so attempt to decrypt it if we have a key
            try {
                return JSON.parse(decrypt(data, redisEncryptionKey));
            } catch (decryptError) {
                // If decryption also fails, log an error and return an empty object
                logger.error(`Failed to parse or decrypt stored key value data: ${decryptError}`);
                return {};
            }
        }
    },
    namespace: `${cortexId}-cortex-context`
});

// Handle Redis connection errors to prevent crashes
keyValueStorageClient.on('error', (error) => {
    logger.error(`Keyv Redis connection error: ${error}`);
});

// Set values to keyv
async function setv(key, value) {
    return keyValueStorageClient && (await keyValueStorageClient.set(key, value));
}

// Get values from keyv
async function getv(key) {
    return keyValueStorageClient && (await keyValueStorageClient.get(key));
}

export {
    keyValueStorageClient,
    setv,
    getv
};
