import Keyv from 'keyv';
import { config } from '../config.js';
import { encrypt, decrypt } from './crypto.js';

const storageConnectionString = config.get('storageConnectionString');
const cortexId = config.get('cortexId');
const redisEncryptionKey = config.get('redisEncryptionKey');

// Create a keyv client to store data
const keyValueStorageClient = new Keyv(storageConnectionString, {
    ssl: true,
    abortConnect: false,
    serialize: (data) => redisEncryptionKey ? encrypt(JSON.stringify(data), redisEncryptionKey) : JSON.stringify(data),
    deserialize: (data) => redisEncryptionKey ? JSON.parse(decrypt(data, redisEncryptionKey)) : JSON.parse(data),
    namespace: `${cortexId}-cortex-context`
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
