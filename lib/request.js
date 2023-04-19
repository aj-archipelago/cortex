import Bottleneck from 'bottleneck/es5.js';
import RequestMonitor from './requestMonitor.js';
import { config } from '../config.js';
import axios from 'axios';
import { setupCache } from 'axios-cache-interceptor';

let cortexAxios = axios;

if (config.get('enableCache')) {
    // Setup cache
    cortexAxios = setupCache(axios, {
        // enable cache for all requests by default
        methods: ['get', 'post', 'put', 'delete', 'patch'],
        interpretHeader: false,
        ttl: 1000 * 60 * 60 * 24 * 7, // 7 days
    }); 
}

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

const postWithMonitor = async (model, url, data, axiosConfigObj) => {
    const monitor = monitors[model];
    monitor.incrementCallCount();
    return cortexAxios.post(url, data, axiosConfigObj);
}

const MAX_RETRY = 10;
const postRequest = async ({ url, data, params, headers, cache }, model) => {
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
            return await limiters[model].schedule(() => postWithMonitor(model, url, data, axiosConfigObj));
        } catch (e) {
            console.error(`Failed request with data ${JSON.stringify(data)}: ${e} - ${e.response?.data?.error?.type || 'error'}: ${e.response?.data?.error?.message}`);
            if (e.response?.status && e.response?.status === 429) {
                monitors[model].incrementError429Count();
            }
            errors.push(e);
        }
    }
    return { error: errors };
}

const request = async (params, model) => {
    const response = await postRequest(params, model);
    const { error, data, cached } = response;
    if (cached) {
        console.info('=== Request served with cached response. ===');
    }
    if (error && error.length > 0) {
        const lastError = error[error.length - 1];
        return { error: lastError.toJSON() ?? lastError ?? error };
    }

    return data;
}

export {
    axios,request, postRequest, buildLimiters
};