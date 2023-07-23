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

const MAX_RETRY = 10; // retries for error handling
const MAX_DUPLICATE_REQUESTS = 3; // duplicate requests to manage latency spikes
const DUPLICATE_REQUEST_AFTER = 10; // 10 seconds

const postRequest = async ({ url, data, params, headers, cache }, model, requestId, pathway) => {
    let promises = [];
    for (let i = 0; i < MAX_RETRY; i++) {
        const modelProperties = config.get('models')[model];
        const enableDuplicateRequests = pathway.enableDuplicateRequests !== undefined ? pathway.enableDuplicateRequests : config.get('enableDuplicateRequests');
        let maxDuplicateRequests = enableDuplicateRequests ? MAX_DUPLICATE_REQUESTS : 1;
        let duplicateRequestAfter = (pathway.duplicateRequestAfter || DUPLICATE_REQUEST_AFTER) * 1000;

        if (enableDuplicateRequests) {
            //console.log(`>>> [${requestId}] Duplicate requests enabled after ${duplicateRequestAfter / 1000} seconds`);
        }

        const axiosConfigObj = { params, headers, cache };
        const streamRequested = (params.stream || data.stream);
        if (streamRequested && modelProperties.supportsStreaming) {
            axiosConfigObj.responseType = 'stream';
            promises.push(limiters[model].schedule(() => postWithMonitor(model, url, data, axiosConfigObj)));
        } else {
            if (streamRequested) {
                console.log(`>>> [${requestId}] ${model} does not support streaming - sending non-streaming request`);
                axiosConfigObj.params.stream = false;
                data.stream = false;
            }
            const controllers = Array.from({ length: maxDuplicateRequests }, () => new AbortController());
            promises = controllers.map((controller, index) =>
                new Promise((resolve, reject) => {
                    const duplicateRequestTime = duplicateRequestAfter * Math.pow(2, index) - duplicateRequestAfter;
                    const jitter = duplicateRequestTime * 0.2 * Math.random();
                    const duplicateRequestTimeout = Math.max(0, duplicateRequestTime + jitter);
                    setTimeout(async () => {
                        try {
                            if (!limiters[model]) {
                                throw new Error(`No limiter for model ${model}!`);
                            }
                            const axiosConfigObj = { params, headers, cache };

                            let response = null;

                            if (!controller.signal?.aborted) {

                                axiosConfigObj.signal = controller.signal;
                                axiosConfigObj.headers['X-Cortex-Request-Index'] = index;

                                if (index === 0) {
                                    //console.log(`>>> [${requestId}] sending request to ${model} API ${axiosConfigObj.responseType === 'stream' ? 'with streaming' : ''}`);
                                } else {
                                    if (modelProperties.supportsStreaming) {
                                        axiosConfigObj.responseType = 'stream';
                                        axiosConfigObj.cache = false;
                                    }
                                    const logMessage = `>>> [${requestId}] taking too long - sending duplicate request ${index} to ${model} API ${axiosConfigObj.responseType === 'stream' ? 'with streaming' : ''}`;
                                    const header = '>'.repeat(logMessage.length);
                                    console.log(`\n${header}\n${logMessage}`);
                                }

                                response = await limiters[model].schedule(() => postWithMonitor(model, url, data, axiosConfigObj));

                                if (!controller.signal?.aborted) {

                                    //console.log(`<<< [${requestId}] received response for request ${index}`);

                                    if (axiosConfigObj.responseType === 'stream') {
                                        // Buffering and collecting the stream data
                                        console.log(`<<< [${requestId}] buffering streaming response for request ${index}`);
                                        response = await new Promise((resolve, reject) => {
                                            let responseData = '';
                                            response.data.on('data', (chunk) => {
                                                responseData += chunk;
                                                //console.log(`<<< [${requestId}] received chunk for request ${index}`);
                                            });
                                            response.data.on('end', () => {
                                                response.data = JSON.parse(responseData);
                                                resolve(response);
                                            });
                                            response.data.on('error', (error) => {
                                                reject(error);
                                            });
                                        });
                                    }
                                }
                            }

                            resolve(response);

                        } catch (error) {
                            if (error.name === 'AbortError' || error.name === 'CanceledError') {
                                //console.log(`XXX [${requestId}] request ${index} was cancelled`);
                                reject(error);
                            } else {
                                console.log(`!!! [${requestId}] request ${index} failed with error: ${error?.response?.data?.error?.message || error}`);
                                reject(error);
                            }
                        } finally {
                            controllers.forEach(controller => controller.abort());
                        }
                    }, duplicateRequestTimeout);
                })
            );
        }

        try {
            const response = await Promise.race(promises);

            if (response.status === 200) {
                return response;
            } else {
                throw new Error(`Received error response: ${response.status}`);
            }
        } catch (error) {
            //console.error(`!!! [${requestId}] failed request with data ${JSON.stringify(data)}: ${error}`);
            if (error.response?.status === 429) {
                monitors[model].incrementError429Count();
            }
            console.log(`>>> [${requestId}] retrying request due to ${error.response?.status} response. Retry count: ${i + 1}`);
            if (i < MAX_RETRY - 1) {
                const backoffTime = 200 * Math.pow(2, i);
                const jitter = backoffTime * 0.2 * Math.random();
                await new Promise(r => setTimeout(r, backoffTime + jitter));
            } else {
                throw error;
            }
        }
    }
};

const request = async (params, model, requestId, pathway) => {
    const response = await postRequest(params, model, requestId, pathway);
    const { error, data, cached } = response;
    if (cached) {
        console.info(`<<< [${requestId}] served with cached response.`);
    }
    if (error && error.length > 0) {
        const lastError = error[error.length - 1];
        return { error: lastError.toJSON() ?? lastError ?? error };
    }
    //console.log("<<< [${requestId}] response: ", data.choices[0].delta || data.choices[0])
    return data;
}

export {
    axios, request, postRequest, buildLimiters
};