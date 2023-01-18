const axios = require('axios');
const Bottleneck = require("bottleneck/es5");

const REQUESTS_PER_SECOND = 20;
const limiter = new Bottleneck({
    minTime: 1000 / REQUESTS_PER_SECOND,
    // maxConcurrent: 20,
})

const MAX_RETRY = 5;
const postRequest = async ({ url, params, headers }) => {
    let retry = 0;
    const errors = []
    for (let i = 0; i < MAX_RETRY; i++) {
        try {
            if (i > 0) {
                console.log(`Retrying request #retry ${i}: ${JSON.stringify(params)}...`);
                await new Promise(r => setTimeout(r, 200 * Math.pow(2, i))); // exponential backoff
            }
            return await limiter.schedule(() => axios.post(url, params, { headers }));
        } catch (e) {
            console.error(`Failed request with params ${JSON.stringify(params)}: ${e}`);
            errors.push(e);
        }
    }
    return { error: errors };
}

const request = async (params) => {
    const response = await postRequest(params);
    const { error, data } = response;
    if (error && error.length > 0) {
        const lastError = error[error.length - 1];
        return { error: lastError.toJSON() ?? lastError ?? error };
    }

    return data;
}

module.exports = {
    request, postRequest
}