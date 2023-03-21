const Bottleneck = require("bottleneck/es5");
const { config } = require('../config');
let axios = require('axios');

if (config.get('enableCache')) {
    // Setup cache
    const { setupCache } = require('axios-cache-interceptor');
    axios = setupCache(axios, {
        // enable cache for all requests by default
        methods: ['get', 'post', 'put', 'delete', 'patch'],
        interpretHeader: false,
        ttl: 1000 * 60 * 60 * 24 * 7, // 7 days
    }); 
}

const limiters = {};

const buildLimiters = (config) => {
    console.log('Building limiters...');
    for (const [name, model] of Object.entries(config.get('models'))) {
        limiters[name] = new Bottleneck({
            minTime: 1000 / (model.requestsPerSecond ?? 100),
            // maxConcurrent: 20,
        })
    }
}

const MAX_RETRY = 10;
const postRequest = async ({ url, data, params, headers, cache }, model) => {
    let retry = 0;
    const errors = []
    for (let i = 0; i < MAX_RETRY; i++) {
        try {
            if (i > 0) {
                console.log(`Retrying request #retry ${i}: ${JSON.stringify(data)}...`);
                await new Promise(r => setTimeout(r, 200 * Math.pow(2, i))); // exponential backoff
            }
            if (!limiters[model]) {
                throw new Error(`No limiter for model ${model}!`);
            }
            const axiosConfigObj = { params, headers, cache };
            if (params.stream || data.stream) {
                axiosConfigObj.responseType = 'stream';
            }
            return await limiters[model].schedule(() => axios.post(url, data, axiosConfigObj));
        } catch (e) {
            console.error(`Failed request with data ${JSON.stringify(data)}: ${e}`);
            errors.push(e);
        }
    }
    return { error: errors };
}

const request = async (params, model) => {
    const response = await postRequest(params, model);
    const { error, data, cached } = response;
    if (cached) {
        console.info('/Request served with cached response.');
    }
    if (error && error.length > 0) {
        const lastError = error[error.length - 1];
        return { error: lastError.toJSON() ?? lastError ?? error };
    }

    return data;
}

module.exports = {
    request, postRequest, buildLimiters
}