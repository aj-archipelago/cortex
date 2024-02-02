import Bottleneck from 'bottleneck/es5.js';
import RequestMonitor from './requestMonitor.js';
import { config } from '../config.js';
import axios from 'axios';
import { setupCache } from 'axios-cache-interceptor';
import Redis from 'ioredis';
import logger from './logger.js';

const connectionString = config.get('storageConnectionString');

if (!connectionString) {
    logger.info('No STORAGE_CONNECTION_STRING found in environment. Redis features (caching, pubsub, clustered limiters) disabled.')
} else {
    logger.info('Using Redis connection specified in STORAGE_CONNECTION_STRING.');
}   

let client;

if (connectionString) {
    try {
        client = new Redis(connectionString);
    } catch (error) {
        logger.error(`Redis connection error: ${error}`);
    }
}

const cortexId = config.get('cortexId');
const connection = client && new Bottleneck.IORedisConnection({ client: client });

const limiters = {};
const monitors = {};

const buildLimiters = (config) => {
    logger.info(`Building ${connection ? 'Redis clustered' : 'local'} model rate limiters for ${cortexId}...`);
    for (const [name, model] of Object.entries(config.get('models'))) {
        const rps = model.requestsPerSecond ?? 100;
        let limiterOptions = {
            minTime: 1000 / rps,
            maxConcurrent: rps,
            reservoir: rps,      // Number of tokens available initially
            reservoirRefreshAmount: rps,     // Number of tokens added per interval
            reservoirRefreshInterval: 1000, // Interval in milliseconds
        };

        // If Redis connection exists, add id and connection to enable clustering
        if (connection) {
            limiterOptions.id = `${cortexId}-${name}-limiter`; // Unique id for each limiter
            limiterOptions.connection = connection;  // Shared Redis connection
        }

        limiters[name] = new Bottleneck(limiterOptions);
        limiters[name].on('error', (err) => {
            logger.error(`Limiter error for ${cortexId}-${name}: ${err}`);
        });
        monitors[name] = new RequestMonitor();
    }
}

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
            logger.info('------------------------');
            logger.info(`${monitorName} Call rate: ${callRate} calls/sec, 429 errors: ${error429Rate * 100}%`);
            logger.info('------------------------');
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
        const enableDuplicateRequests = pathway?.enableDuplicateRequests !== undefined ? pathway.enableDuplicateRequests : config.get('enableDuplicateRequests');
        let maxDuplicateRequests = enableDuplicateRequests ? MAX_DUPLICATE_REQUESTS : 1;
        let duplicateRequestAfter = (pathway?.duplicateRequestAfter || DUPLICATE_REQUEST_AFTER) * 1000;

        if (enableDuplicateRequests) {
            //logger.info(`>>> [${requestId}] Duplicate requests enabled after ${duplicateRequestAfter / 1000} seconds`);
        }

        const axiosConfigObj = { params, headers, cache };
        const streamRequested = (params?.stream || data?.stream);
        if (streamRequested && modelProperties.supportsStreaming) {
            axiosConfigObj.responseType = 'stream';
            promises.push(limiters[model].schedule(() => postWithMonitor(model, url, data, axiosConfigObj)));
        } else {
            if (streamRequested) {
                logger.info(`>>> [${requestId}] ${model} does not support streaming - sending non-streaming request`);
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
                                    //logger.info(`>>> [${requestId}] sending request to ${model} API ${axiosConfigObj.responseType === 'stream' ? 'with streaming' : ''}`);
                                } else {
                                    if (modelProperties.supportsStreaming) {
                                        axiosConfigObj.responseType = 'stream';
                                        axiosConfigObj.cache = false;
                                    }
                                    const logMessage = `>>> [${requestId}] taking too long - sending duplicate request ${index} to ${model} API ${axiosConfigObj.responseType === 'stream' ? 'with streaming' : ''}`;
                                    const header = '>'.repeat(logMessage.length);
                                    logger.info(`\n${header}\n${logMessage}`);
                                }

                                response = await limiters[model].schedule(() => postWithMonitor(model, url, data, axiosConfigObj));

                                if (!controller.signal?.aborted) {

                                    //logger.info(`<<< [${requestId}] received response for request ${index}`);

                                    if (axiosConfigObj.responseType === 'stream') {
                                        // Buffering and collecting the stream data
                                        logger.info(`<<< [${requestId}] buffering streaming response for request ${index}`);
                                        response = await new Promise((resolve, reject) => {
                                            let responseData = '';
                                            response.data.on('data', (chunk) => {
                                                responseData += chunk;
                                                //logger.info(`<<< [${requestId}] received chunk for request ${index}`);
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
                                //logger.info(`XXX [${requestId}] request ${index} was cancelled`);
                                reject(error);
                            } else {
                                logger.info(`!!! [${requestId}] request ${index} failed with error: ${error?.response?.data?.error?.message || error}`);
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

            // if response status is 2xx
            if (response.status >= 200 && response.status < 300) {
                return response;
            } else {
                throw new Error(`Received error response: ${response.status}`);
            }
        } catch (error) {
            //logger.error(`!!! [${requestId}] failed request with data ${JSON.stringify(data)}: ${error}`);
            if (error.response) {
                const status = error.response.status;
                if ((status === 429) || (status >= 500 && status < 600)) {
                    if (status === 429) {
                        monitors[model].incrementError429Count();
                    }
                    logger.info(`>>> [${requestId}] retrying request due to ${status} response. Retry count: ${i + 1}`);
                    if (i < MAX_RETRY - 1) {
                        const backoffTime = 200 * Math.pow(2, i);
                        const jitter = backoffTime * 0.2 * Math.random();
                        await new Promise(r => setTimeout(r, backoffTime + jitter));
                    } else {
                        throw error;
                    }
                } else {
                    throw error;
                }
            } else {
                throw error;
            }
        }
    }
};

const request = async (params, model, requestId, pathway) => {
    try {
        const response = await postRequest(params, model, requestId, pathway);
        const { error, data, cached } = response;
        if (cached) {
            logger.info(`<<< [${requestId}] served with cached response.`);
        }
        if (error && error.length > 0) {
            const lastError = error[error.length - 1];
            return { error: lastError.toJSON() ?? lastError ?? error };
        }
        //logger.info(`<<< [${requestId}] response: ${data.choices[0].delta || data.choices[0]}`)
        return data;
    } catch (error) {
        logger.error(`Error in request: ${error.message || error}`);
        return { error: error };
    } 
}

export {
    axios, request, postRequest, buildLimiters
};