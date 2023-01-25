const axios = require('axios');
const Bottleneck = require("bottleneck/es5");

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

const MAX_RETRY = 5;
const postRequest = async ({ url, params, headers }, model) => {
    let retry = 0;
    const errors = []
    for (let i = 0; i < MAX_RETRY; i++) {
        try {
            if (i > 0) {
                console.log(`Retrying request #retry ${i}: ${JSON.stringify(params)}...`);
                await new Promise(r => setTimeout(r, 200 * Math.pow(2, i))); // exponential backoff
            }
            if (!limiters[model]) {
                throw new Error(`No limiter for model ${model}!`);
            }
            return await limiters[model].schedule(() => axios.post(url, params, { headers }));
        } catch (e) {
            console.error(`Failed request with params ${JSON.stringify(params)}: ${e}`);
            errors.push(e);
        }
    }
    return { error: errors };
}

const request = async (params, model) => {
    const response = await postRequest(params, model);
    const { error, data } = response;
    if (error && error.length > 0) {
        const lastError = error[error.length - 1];
        return { error: lastError.toJSON() ?? lastError ?? error };
    }

    return data;
}

module.exports = {
    request, postRequest, buildLimiters
}