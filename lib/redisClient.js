const Keyv = require('keyv');

class redisClient {
    constructor(config) {
        const _redisUrl = config.get('redisUrl');
        const _redisPassword = config.get('redisKey');
        const _keyv = new Keyv(_redisUrl, {
            password: _redisPassword,
            ssl: true,
            abortConnect: false,
            serialize: JSON.stringify,
            deserialize: JSON.parse,
            namespace: 'cortex-context'
        });
        this.keyv = _keyv;
    }

    // Set values to keyv
    async setv(key, value) {
        return await this.keyv.set(key, value);
    }

    // Get values from keyv
    async getv(key) {
        return await this.keyv.get(key);
    }  
}

let redisInstance = null;

function createRedisClient(config) {
    if (!redisInstance) {
      redisInstance = new redisClient(config);
    }
    return redisInstance;
}

module.exports = config => createRedisClient(config);
  
