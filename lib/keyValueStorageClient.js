const Keyv = require('keyv');
const { config } = require('../config');

const storageConnectionString = config.get('storageConnectionString');

if (!config.get('storageConnectionString')) {
    console.log('No storageConnectionString specified. Please set the storageConnectionString or STORAGE_CONNECTION_STRING environment variable if you need caching or stored context.')
}

// Create a keyv client to store data
const keyValueStorageClient = new Keyv(storageConnectionString, {
    ssl: true,
    abortConnect: false,
    serialize: JSON.stringify,
    deserialize: JSON.parse,
    namespace: 'cortex-context'
});

// Set values to keyv
async function setv(key, value) {
    return (keyValueStorageClient && await keyValueStorageClient.set(key, value));
}

// Get values from keyv
async function getv(key) {
    return (keyValueStorageClient && await keyValueStorageClient.get(key));
}

module.exports = {
    keyValueStorageClient,
    setv,
    getv
};
