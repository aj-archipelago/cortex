import RequestDurationEstimator from '../../lib/requestDurationEstimator.js';
import ModelPlugin from './modelPlugin.js';
import { request } from '../../lib/request.js';
import { publishRequestProgress } from '../../lib/redisSubscription.js';

const requestDurationEstimator = new RequestDurationEstimator(10);

/**
 * @description This plugin is for the OpenAI DALL-E 3 model.
 */
class OpenAIDallE3Plugin extends ModelPlugin {
    constructor(config, pathway, modelName, model) {
        super(config, pathway, modelName, model);
    }

    /**
     * @description At the time of writing, the DALL-E 3 API on Azure is sync-only, so to support async
     * we keep the request open and send progress updates to the client 
     * over a websocket.
     */

    async executeRequest(url, data, params, headers, prompt, requestId, pathway) {
        try {
            this.aiRequestStartTime = new Date();
            this.requestId = requestId;
            this.logRequestStart(url, data);
            const responseData = await request({ url, data, params, headers, cache: this.shouldCache }, this.modelName, this.requestId, pathway);
               
            this.logRequestData(data, responseData, prompt);
            return this.parseResponse(responseData);
        } catch (error) {
            // Log the error and continue
            console.error(error);
        }
    }

    async execute(text, parameters, _, pathwayResolver) {
        const url = this.requestUrl(text);
        const data = JSON.stringify({ prompt: text });

        const { requestId, pathway } = pathwayResolver;

        const makeRequest = () => this.executeRequest(url, data, {}, this.model.headers, {}, requestId, pathway);

        if (!parameters.async) {
            // synchronous request
            return await makeRequest();
        }
        else {
            // async request
            requestDurationEstimator.startRequest(requestId);
            const requestPromise = makeRequest();
            this.#sendRequestUpdates(requestId, requestPromise);
        }
    }

    /**
     * Send progress updates to the client.
     * 
     * @param {*} requestId 
     * @param {*} requestPromise 
     * @returns 
     */
    async #sendRequestUpdates(requestId, requestPromise) {
        let state = { status: "pending" };
        let attemptCount = 0;
        let data = null;

        requestPromise
        .then((response) => handleResponse(response))
        .catch((error) => handleResponse(error));

        function handleResponse(response) {
            const status = response?.error ? "failed" : "succeeded";
            const data = JSON.stringify(response?.error ? response : response);

            const requestProgress = {
                requestId,
                status,
                progress: 1,
                data,
            };

            state.status = status;
            requestDurationEstimator.endRequest();
            publishRequestProgress(requestProgress);
        }

        // publish an update every 2 seconds, using the request duration estimator to calculate
        // the percent complete
        do {
            let progress =
                requestDurationEstimator.calculatePercentComplete();

                await publishRequestProgress({
                    requestId,
                    status: "pending",
                    progress,
                    data,
                });

            if (state.status !== "pending") {
                break;
            }

            // sleep for 2 seconds
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        while (state.status !== "succeeded" && attemptCount++ < 30);
        
        return data;
    }
}

export default OpenAIDallE3Plugin;
