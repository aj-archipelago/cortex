import Bottleneck from 'bottleneck/es5.js';
import RequestMonitor from './requestMonitor.js';
import { config } from '../config.js';
import axios from 'axios';
import { setupCache } from 'axios-cache-interceptor';
import Redis from 'ioredis';
import logger from './logger.js';
import { v4 as uuidv4 } from 'uuid';

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

let modelEndpoints = {};

const createLimiter = (endpoint, name, index) => {
    const rps = endpoint.requestsPerSecond ?? 100;
    let limiterOptions = {
        minTime: 1000 / rps,
        maxConcurrent: rps,
        reservoir: rps,      // Number of tokens available initially
        reservoirRefreshAmount: rps,     // Number of tokens added per interval
        reservoirRefreshInterval: 1000, // Interval in milliseconds
    };

    // If Redis connection exists, add id and connection to enable clustering
    if (connection) {
        limiterOptions.id = `${cortexId}-${name}-${index}-limiter`; // Unique id for each limiter
        limiterOptions.connection = connection;  // Shared Redis connection
        }

    endpoint.limiter = new Bottleneck(limiterOptions);

    endpoint.limiter.on('error', (err) => {
        logger.error(`Limiter error for ${cortexId}-${name}-${index}: ${err}`);
        endpoint.limiter.disconnect();
        createLimiter(endpoint, name, index);
        logger.info(`New limiter created for ${cortexId}-${name}-${index}`)
    });

    endpoint.limiter.on('failed', (error, info) => {
        if (error.name === 'CanceledError') {
            logger.debug(`Limiter request cancelled for ${cortexId}-${name}-${index}: Id: ${info.options.id || 'none'}`);
            endpoint.monitor.incrementErrorCount();
        } else {
            logger.error(`Limiter request failed for ${cortexId}-${name}-${index}: Id: ${info.options.id || 'none'}: ${error?.message || error}`);
        }
    });

    endpoint.limiter.on('debug', (message) => {
        if (!message.includes('heartbeat.lua')) {
            logger.debug(`Limiter ${cortexId}-${name}-${index}: ${message}`);
        }
    });
}

const buildModelEndpoints = (config) => {
    modelEndpoints = JSON.parse(JSON.stringify(config.get('models')));
    logger.info(`Building ${connection ? 'Redis clustered' : 'local'} model rate limiters for ${cortexId}...`);
    for (const [name, model] of Object.entries(modelEndpoints)) {
        model.endpoints.forEach((endpoint, index) => {
            createLimiter(endpoint, name, index)
            endpoint.monitor = new RequestMonitor();
        });
    }
}

let currentIndex = 0; // for round-robin selection

const selectEndpoint = (model) => {
    if (!model || !Array.isArray(model.endpoints) || model.endpoints.length === 0) {
        return null;
    } else {
        logger.debug(`Selecting endpoint for model ${model.name}...`);
        if (model.endpoints.length === 1) {
            logger.debug(`Only one endpoint for model ${model.name}. No selection required.`);
            return model.endpoints[0];
        }

        let healthyEndpoints = model.endpoints.filter(endpoint => endpoint.monitor.healthy);
        if (healthyEndpoints.length === 0) {
            const selectedEndpoint = model.endpoints[currentIndex % model.endpoints.length];
            currentIndex++;
            logger.warn(`No healthy endpoints for model ${model.name}. Using round-robin selection. Selected: ${selectedEndpoint.name || 'default'}`);
            return selectedEndpoint;
        }

        healthyEndpoints.forEach(endpoint =>{
            logger.debug(`Healthy endpoint: ${endpoint.name || 'default'}, duration: ${endpoint.monitor.getAverageCallDuration()}ms`);
        })

        let selectedEndpoint;
        const durations = healthyEndpoints.map(endpoint => endpoint.monitor.getAverageCallDuration());
        if (shouldUseRoundRobin(durations)) {
            selectedEndpoint = healthyEndpoints[currentIndex % healthyEndpoints.length];
            currentIndex++;
            logger.debug(`All endpoints are performing similarly. Using round-robin selection. Selected: ${selectedEndpoint.name || 'default'}`);
        } else {
            selectedEndpoint = fastestEndpoint(healthyEndpoints);
            logger.debug(`Selected fastest endpoint: ${selectedEndpoint.name || 'default'}`);
        }

        return selectedEndpoint;
    }
}

const calculateStandardDeviation = (durations) => {
    const mean = durations.reduce((total, value) => total + value, 0) / durations.length;
    const variance = durations.reduce((total, value) => total + Math.pow(value - mean, 2), 0) / durations.length;
    return Math.sqrt(variance);
}

const shouldUseRoundRobin = (durations) => {
    const standardDeviation = calculateStandardDeviation(durations);
    const threshold = 10;
    return standardDeviation <= threshold;
}

const fastestEndpoint = (endpoints) => {
    return endpoints.reduce((fastest, current) => {
        if (current.monitor.getAverageCallDuration() < fastest.monitor.getAverageCallDuration()) {
            return current;
        } else {
            return fastest;
        }
    });
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

//log statistics about active endpoints
setInterval(() => {
  // Iterate over each model
  for (const [name, model] of Object.entries(modelEndpoints)) {
    // Iterate over each endpoint in the current model
    let endpointIndex = 0;
    model.endpoints.forEach((endpoint) => {
        const monitor = endpoint.monitor;
        if (!monitor) {
            // Skip if monitor does not exist
            return;
        }

        const callRate = monitor.getPeakCallRate();

        if (callRate > 0) {
            const error429Rate = monitor.getError429Rate();
            const errorRate = monitor.getErrorRate();
            const avgCallDuration = monitor.getAverageCallDuration();
            logger.debug('------------------------');
            logger.debug(`Monitor of ${name} endpoint ${endpoint.name || endpointIndex} Call rate: ${callRate} calls/sec, duration: ${avgCallDuration}ms, 429 errors: ${error429Rate * 100}%, errors: ${errorRate * 100}%`);
            logger.debug('------------------------');
        }
        endpointIndex++;
    });
  }
}, 30000); // Log rates every 30 seconds

const requestWithMonitor = async (endpoint, url, data, axiosConfigObj) => {
    //logger.warn(`Requesting ${url} with data: ${JSON.stringify(data)}`);
    const callId = endpoint?.monitor?.startCall();
    let response;
    try {
        if (axiosConfigObj?.method == 'GET'){
            response = await cortexAxios.get(url, axiosConfigObj);
        } else {
            response = await cortexAxios.post(url, data, axiosConfigObj);
        }
    } catch (error) {
        // throw new error with duration as part of the error data
        throw { ...error, duration: endpoint?.monitor?.incrementErrorCount(callId, error?.response?.status || null) };
    }
    let duration;
    if (response.status >= 200 && response.status < 300) {
        duration = endpoint?.monitor?.endCall(callId);
    } else {
        duration = endpoint?.monitor?.incrementErrorCount(callId, response.status);
    }

    return { response, duration };
}

const MAX_RETRY = 10; // retries for error handling
const MAX_DUPLICATE_REQUESTS = 3; // duplicate requests to manage latency spikes
const DUPLICATE_REQUEST_AFTER = 10; // 10 seconds

const getDuplicateRequestDelay = (index, duplicateRequestAfter) => {
    const duplicateRequestTime = duplicateRequestAfter * Math.pow(2, index) - duplicateRequestAfter;
    const jitter = duplicateRequestTime * 0.2 * Math.random();
    const duplicateRequestTimeout = Math.max(0, duplicateRequestTime + jitter);
    return duplicateRequestTimeout;
}

const makeRequest = async (cortexRequest) => {
    let promises = [];
    // retry certain errors up to MAX_RETRY times
    for (let i = 0; i < MAX_RETRY; i++) {
        const { url, data, params, headers, cache, selectedEndpoint, requestId, pathway, model, stream, method} = cortexRequest;
        const enableDuplicateRequests = pathway?.enableDuplicateRequests !== undefined ? pathway.enableDuplicateRequests : config.get('enableDuplicateRequests');
        const maxDuplicateRequests = enableDuplicateRequests ? MAX_DUPLICATE_REQUESTS : 1;
        const duplicateRequestAfter = (pathway?.duplicateRequestAfter || DUPLICATE_REQUEST_AFTER) * 1000;

        const axiosConfigObj = { params, headers, cache, method };
        const streamRequested = (stream || params?.stream || data?.stream);
        // if we're using streaming, duplicate requests are
        // not supported, so we just push one promise into the array
        if (streamRequested && model.supportsStreaming) {
            axiosConfigObj.responseType = 'stream';
            promises.push(selectedEndpoint.limiter.schedule({expiration: pathway.timeout * 1000 + 1000, id: `${requestId}_${uuidv4()}`},() => requestWithMonitor(selectedEndpoint, url, data, axiosConfigObj)));
        } else {
            if (streamRequested) {
                logger.info(`>>> [${requestId}] ${model.name || 'This model'} does not support streaming - sending non-streaming request`);
                axiosConfigObj.params.stream = false;
                data.stream = false;
            }
            // if we're not streaming, we push at least one promise
            // into the array, but if we're supporting duplicate
            // requests we push one for each potential duplicate,
            // heading to a new endpoint (if available) and
            // staggered by a jittered amount of time
            const controllers = Array.from({ length: maxDuplicateRequests }, () => new AbortController());
            promises = controllers.map((controller, index) =>
                new Promise((resolve, reject) => {
                    setTimeout(async () => {
                        try {
                            if (index > 0) {
                                cortexRequest.selectNewEndpoint();
                            }
                            const { url, data, params, headers, cache, selectedEndpoint, requestId, pathway, model } = cortexRequest;
                            const endpointName = selectedEndpoint.name || model;
                            if (!selectedEndpoint.limiter) {
                                throw new Error(`No limiter for endpoint ${endpointName}!`);
                            }
                            const axiosConfigObj = { params, headers, cache, method };

                            let response = null;
                            let duration = null;

                            if (!controller.signal?.aborted) {

                                axiosConfigObj.signal = controller.signal;
                                axiosConfigObj.headers['X-Cortex-Request-Index'] = index;

                                if (index > 0) {
                                    const logMessage = `>>> [${requestId}] taking too long - sending duplicate request ${index} to ${endpointName} API`;
                                    const header = '>'.repeat(logMessage.length);
                                    logger.info(`\n${header}\n${logMessage}`);
                                }

                                ({ response, duration } = await selectedEndpoint.limiter.schedule({expiration: pathway.timeout * 1000 + 1000, id: `${requestId}_${uuidv4()}`}, () => requestWithMonitor(selectedEndpoint, url, data, axiosConfigObj)));

                                if (!controller.signal?.aborted) {
                                    logger.verbose(`<<< [${requestId}] received response for request ${index}`);
                                }
                            }

                            resolve({ response, duration });

                        } catch (error) {
                            if (error.name === 'AbortError' || error.name === 'CanceledError') {
                                //logger.info(`XXX [${requestId}] request ${index} was cancelled`);
                                reject(error);
                            } else {
                                logger.error(`!!! [${requestId}] request ${index} failed with error: ${error?.response?.data?.message || error?.response?.data?.error?.message || error?.message || error}`);
                                reject(error);
                            }
                        } finally {
                            controllers.forEach(controller => controller.abort());
                        }
                    }, getDuplicateRequestDelay(index, duplicateRequestAfter));
                })
            );
        }

        // no requests have been made yet, but the promises array
        // is full, so now we execute them in parallel
        try {
            const { response, duration } = await Promise.race(promises);

            // if response status is 2xx
            if (response.status >= 200 && response.status < 300) {
                return { response, duration };
            } else {
                throw new Error(`Received error response: ${response.status}`);
            }
        } catch (error) {
            const { response, duration, code } = error;
            if (response || code === 'ECONNRESET') {
                const status = response?.status || 502; // default to 502 if ECONNRESET
                // if there is only one endpoint, only retry select error codes
                if (cortexRequest.model.endpoints.length === 1) {
                    if (status !== 429 &&
                        status !== 408 &&
                        status !== 502 &&
                        status !== 503 &&
                        status !== 504) {
                        return { response, duration };
                    }
                    // set up for a retry by reinitializing the request
                    cortexRequest.initRequest();
                } else {
                    // if there are multiple endpoints, retry everything by default
                    // as it could be a temporary issue with one endpoint
                    // certain errors (e.g. 400) are problems with the request itself
                    // and should not be retried
                    if (status == 400) {
                        return { response, duration };
                    }
                    // set up for a retry by selecting a new endpoint, which will also reinitialize the request
                    cortexRequest.selectNewEndpoint();
                }

                logger.info(`>>> [${requestId}] retrying request (${duration}ms) due to ${status} response. Retry count: ${i + 1}`);
                if (i < MAX_RETRY - 1) {
                    const backoffTime = 200 * Math.pow(2, i);
                    const jitter = backoffTime * 0.2 * Math.random();
                    await new Promise(r => setTimeout(r, backoffTime + jitter));
                } else {
                    return { response, duration };
                }
            } else {
                throw error;
            }
        }
    }
};

const executeRequest = async (cortexRequest) => {
    try {
        const { response, duration } = await makeRequest(cortexRequest);
        const requestId = cortexRequest.requestId;
        const { error, data, cached } = response;
        if (cached) {
            logger.info(`<<< [${requestId}] served with cached response.`);
        }
        if (error) {
            throw { error: error.toJSON() ?? error };
        }
        return { data, duration };
    } catch (error) {
        logger.error(`Error in request: ${error.message || error}`);
        throw error;
    } 
}

export {
    axios, executeRequest, buildModelEndpoints, selectEndpoint, modelEndpoints
};