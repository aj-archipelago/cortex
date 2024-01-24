import Keyv from 'keyv';
import { config } from '../config.js';

const storageConnectionString = config.get('storageConnectionString');
const cortexId = config.get('cortexId');

// Create a keyv client to store data
const keyValueStorageClient = new Keyv(storageConnectionString, {
    ssl: true,
    abortConnect: false,
    serialize: JSON.stringify,
    deserialize: JSON.parse,
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
