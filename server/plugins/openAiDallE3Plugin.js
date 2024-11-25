import RequestMonitor from '../../lib/requestMonitor.js';
import ModelPlugin from './modelPlugin.js';
import { publishRequestProgress } from '../../lib/redisSubscription.js';

const requestDurationEstimator = new RequestMonitor(10);

/**
 * @description This plugin is for the OpenAI DALL-E 3 model.
 */
class OpenAIDallE3Plugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
    }

    /**
     * @description At the time of writing, the DALL-E 3 API on Azure is sync-only, so to support async
     * we keep the request open and send progress updates to the client 
     * over a websocket.
     */

    async execute(text, parameters, _, cortexRequest) {
        const { pathwayResolver } = cortexRequest;
        cortexRequest.data = JSON.stringify({ prompt: text });

        const { requestId } = pathwayResolver;

        const makeRequest = () => this.executeRequest(cortexRequest);

        if (!parameters.async) {
            // synchronous request
            return await makeRequest();
        }
        else {
            // async request
            const callid = requestDurationEstimator.startCall();
            const requestPromise = makeRequest();
            this.#sendRequestUpdates(requestId, requestPromise, callid);
        }
    }

    /**
     * Send progress updates to the client.
     * 
     * @param {*} requestId 
     * @param {*} requestPromise 
     * @returns 
     */
    async #sendRequestUpdates(requestId, requestPromise, callid) {
        let state = { status: "pending" };
        let attemptCount = 0;
        let data = null;

        requestPromise
        .then((response) => handleResponse(response))
        .catch((error) => handleResponse(error, true));

        function handleResponse(response, isError = false) {
            let status = "succeeded";
            let data;

            if (isError) {
                status = "failed";
                data = JSON.stringify({ error: response.message || response });
            } else if (response.data?.error) {
                status = "failed";
                data = JSON.stringify(response.data);
            } else {
                data = JSON.stringify(response);
            }

            const requestProgress = {
                requestId,
                status,
                progress: 1,
                data,
            };

            state.status = status;
            requestDurationEstimator.endCall(callid);
            publishRequestProgress(requestProgress);
        }

        // publish an update every 2 seconds, using the request duration estimator to calculate
        // the percent complete
        do {
            let progress =
                requestDurationEstimator.calculatePercentComplete(callid);

            if (typeof progress === 'number' && !isNaN(progress) && progress >= 0 && progress <= 1) {
                await publishRequestProgress({
                    requestId,
                    status: "pending",
                    progress,
                    data,
                });
            }

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
