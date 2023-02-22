const Keyv = require('keyv');

const keyv = new Keyv(process.env.REDIS_CONNECTION_URL,
    {
        password: process.env.REDIS_CONNECTION_KEY,
        ssl: true,
        abortConnect: false
    }
);

// Set values to keyv
const setv = async (key, value) => {
    await keyv.set(key, JSON.stringify(value));
}

// Get values from keyv
const getv = async (key) => {
    return JSON.parse(await keyv.get(key));
}

module.exports = {
    keyv, setv, getv
}