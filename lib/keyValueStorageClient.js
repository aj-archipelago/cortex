const Keyv = require('keyv');
const { config } = require('../config');

const storageConnectionString = config.get('storageConnectionString');


if (!config.get('storageConnectionString')) {
    console.log('No storageConnectionString specified. Please set the storageConnectionString or STORAGE_CONNECTION_STRING environment variable if you need caching or stored context.')
}


// Create a keyv client to store data
const keyValueStorageClient = new Keyv(storageConnectionString);


// Set values to keyv
async function setValue(key, value) {
    if (!keyvClient) return;
    return await keyvClient.set(key, JSON.stringify(value));
}

// Get values from keyv
async function getValue(key) {
    if (!keyvClient) return;
    return JSON.parse(await keyvClient.get(key));
}


module.exports = {
    keyValueStorageClient,
    setv: setValue,
    getv: getValue
};
