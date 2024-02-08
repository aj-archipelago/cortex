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
            logger.debug(`Request cancelled for ${cortexId}-${name}-${index}: Id: ${info.options.id || 'none'}`);
        } else {
            logger.error(`Request failed for ${cortexId}-${name}-${index}: Id: ${info.options.id || 'none'}: ${error}`);
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

/* V1
const selectEndpoint = (model) => {
    if (!model || !Array.isArray(model.endpoints) || model.endpoints.length === 0) {
        return null;
    } else {
        let minAvgCallDuration = Infinity;
        let selectedEndpoint = model.endpoints[0];
        if (model.endpoints.length === 1) {
            logger.debug(`Only one endpoint for model ${model.name}. No selection required.`);
            return selectedEndpoint;
        }

        logger.debug(`Selecting fastest endpoint for model ${model.name}...`);
        let eindex = 0;
        model.endpoints.forEach(endpoint => {
            if (endpoint.monitor) {
                let avgCallDuration = endpoint.monitor.getAverageCallDuration();
                logger.debug(`Endpoint ${endpoint.name || eindex} average call duration: ${avgCallDuration}`);
                if (avgCallDuration < minAvgCallDuration) {
                    minAvgCallDuration = avgCallDuration;
                    selectedEndpoint = endpoint;
                }
            }
            eindex++;
        });

        logger.debug(`Selected endpoint: ${selectedEndpoint.name || 'default'}`);
        return selectedEndpoint;
    }
}
*/

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
            logger.warn(`No healthy endpoints for model ${model.name}.`);
            return null;
        }

        healthyEndpoints.forEach(endpoint =>{
            logger.debug(`Healthy endpoint: ${endpoint.name || 'default'}, duration: ${endpoint.monitor.getAverageCallDuration()}ms`);
        })

        let selectedEndpoint;
        if (allEndpointsSameDuration(healthyEndpoints)) {
            selectedEndpoint = healthyEndpoints[currentIndex % healthyEndpoints.length];
            currentIndex++;
            logger.debug(`All endpoints have the same duration. Using round-robin selection. Selected: ${selectedEndpoint.name || 'default'}`);
        } else {
            selectedEndpoint = fastestEndpoint(healthyEndpoints);
            logger.debug(`Selected fastest endpoint: ${selectedEndpoint.name || 'default'}`);
        }

        return selectedEndpoint;
    }
}

const allEndpointsSameDuration = (endpoints) => {
    const avgCallDuration = endpoints[0].monitor.getAverageCallDuration();
    return endpoints.every(endpoint => endpoint.monitor.getAverageCallDuration() === avgCallDuration);
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
        const error429Rate = monitor.getError429Rate();
        const errorRate = monitor.getErrorRate();
        const avgCallDuration = monitor.getAverageCallDuration();

        if (callRate > 0) {
            logger.debug('------------------------');
            logger.debug(`Monitor of ${name} endpoint ${endpoint.name || endpointIndex} Call rate: ${callRate} calls/sec, duration: ${avgCallDuration}ms, 429 errors: ${error429Rate * 100}%, errors: ${errorRate * 100}%`);
            logger.debug('------------------------');
        }
        endpointIndex++;
    });
  }
}, 10000); // Log rates every 10 seconds (10000 ms).

const postWithMonitor = async (endpoint, url, data, axiosConfigObj) => {
    return cortexAxios.post(url, data, axiosConfigObj);
}

const MAX_RETRY = 10; // retries for error handling
const MAX_DUPLICATE_REQUESTS = 3; // duplicate requests to manage latency spikes
const DUPLICATE_REQUEST_AFTER = 10; // 10 seconds

const postRequest = async (cortexRequest) => {
    let promises = [];
    for (let i = 0; i < MAX_RETRY; i++) {
        const { url, data, params, headers, cache, selectedEndpoint, requestId, pathway, model} = cortexRequest;
        const enableDuplicateRequests = pathway?.enableDuplicateRequests !== undefined ? pathway.enableDuplicateRequests : config.get('enableDuplicateRequests');
        let maxDuplicateRequests = enableDuplicateRequests ? MAX_DUPLICATE_REQUESTS : 1;
        let duplicateRequestAfter = (pathway?.duplicateRequestAfter || DUPLICATE_REQUEST_AFTER) * 1000;

        if (enableDuplicateRequests) {
            //logger.info(`>>> [${requestId}] Duplicate requests enabled after ${duplicateRequestAfter / 1000} seconds`);
        }

        const axiosConfigObj = { params, headers, cache };
        const streamRequested = (params?.stream || data?.stream);
        if (streamRequested && model.supportsStreaming) {
            axiosConfigObj.responseType = 'stream';
            promises.push(selectedEndpoint.limiter.schedule({expiration: pathway.timeout * 1000 + 1000, id: `${requestId}_${uuidv4()}`},() => postWithMonitor(selectedEndpoint, url, data, axiosConfigObj)));
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
                            const endpointName = selectedEndpoint.name || model;
                            if (!selectedEndpoint.limiter) {
                                throw new Error(`No limiter for endpoint ${endpointName}!`);
                            }
                            const axiosConfigObj = { params, headers, cache };

                            let response = null;

                            if (!controller.signal?.aborted) {

                                axiosConfigObj.signal = controller.signal;
                                axiosConfigObj.headers['X-Cortex-Request-Index'] = index;

                                if (index === 0) {
                                    //logger.info(`>>> [${requestId}] sending request to ${endpointName} API ${axiosConfigObj.responseType === 'stream' ? 'with streaming' : ''}`);
                                } else {
                                    if (model.supportsStreaming) {
                                        axiosConfigObj.responseType = 'stream';
                                        axiosConfigObj.cache = false;
                                    }
                                    const logMessage = `>>> [${requestId}] taking too long - sending duplicate request ${index} to ${endpointName} API ${axiosConfigObj.responseType === 'stream' ? 'with streaming' : ''}`;
                                    const header = '>'.repeat(logMessage.length);
                                    logger.info(`\n${header}\n${logMessage}`);
                                }

                                response = await selectedEndpoint.limiter.schedule({expiration: pathway.timeout * 1000 + 1000, id: `${requestId}_${uuidv4()}`}, () => postWithMonitor(selectedEndpoint, url, data, axiosConfigObj));

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
                selectedEndpoint.monitor.incrementErrorCount();
                const status = error.response.status;
                if (status === 429) {
                    selectedEndpoint.monitor.incrementError429Count();
                }
                logger.info(`>>> [${requestId}] retrying request due to ${status} response. Retry count: ${i + 1}`);
                if (i < MAX_RETRY - 1) {
                    const backoffTime = 200 * Math.pow(2, i);
                    const jitter = backoffTime * 0.2 * Math.random();
                    await new Promise(r => setTimeout(r, backoffTime + jitter));
                } else {
                    throw error;
                }
                cortexRequest.selectNewEndpoint();
            } else {
                throw error;
            }
        }
    }
};

const executeRequest = async (cortexRequest) => {
    try {
        const endpoint = cortexRequest.selectedEndpoint;
        const callId = endpoint?.monitor?.startCall();
        const response = await postRequest(cortexRequest);
        endpoint?.monitor?.endCall(callId);
        const requestId = cortexRequest.requestId;
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
    axios, executeRequest, buildModelEndpoints, selectEndpoint, modelEndpoints
};