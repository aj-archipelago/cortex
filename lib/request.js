const axios = require('axios');
const Bottleneck = require("bottleneck/es5");
const RequestMonitor = require('./requestMonitor');

const limiters = {};
const monitors = {};

const buildLimiters = (config) => {
    console.log('Building limiters...');
    for (const [name, model] of Object.entries(config.get('models'))) {
        const rps = model.requestsPerSecond ?? 100;
        limiters[name] = new Bottleneck({
            minTime: 1000 / rps,
            maxConcurrent: rps,
            reservoir: rps,      // Number of tokens available initially
            reservoirRefreshAmount: rps,     // Number of tokens added per interval
            reservoirRefreshInterval: 1000, // Interval in milliseconds
        });
        monitors[name] = new RequestMonitor();
    }
}

setInterval(() => {
    const monitorKeys = Object.keys(monitors);

    // Skip logging if the monitors object does not exist or is empty
    if (!monitorKeys || monitorKeys.length === 0) {
      return;
    }

    monitorKeys.forEach((monitorName) => {
        const monitor = monitors[monitorName];
        const callRate = monitor.getPeakCallRate();
        const error429Rate = monitor.getError429Rate();
        if (callRate > 0) {
            console.log('------------------------');
            console.log(`${monitorName} Call rate: ${callRate} calls/sec, 429 errors: ${error429Rate * 100}%`);
            console.log('------------------------');
            // Reset the rate monitor to start a new monitoring interval.
            monitor.reset();
        }
    });
  }, 10000); // Log rates every 10 seconds (10000 ms).

const postWithMonitor = async (model, url, data, params, headers) => {
    const monitor = monitors[model];
    monitor.incrementCallCount();
    return axios.post(url, data, { params, headers });
}

const MAX_RETRY = 10;
const postRequest = async ({ url, data, params, headers }, model) => {
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
            return await limiters[model].schedule(() => postWithMonitor(model, url, data, params, headers));
        } catch (e) {
            console.error(`Failed request with data ${JSON.stringify(data)}: ${e}`);
            if (e.response.status === 429) {
                monitors[model].incrementError429Count();
            }
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