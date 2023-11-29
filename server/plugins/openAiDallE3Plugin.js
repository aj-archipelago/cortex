import RequestDurationEstimator from '../../lib/requestDurationEstimator.js';
import pubsub from '../pubsub.js';
import ModelPlugin from './modelPlugin.js';

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

        requestPromise.then((response) => {
            state.status = "succeeded";
            requestDurationEstimator.endRequest();
            pubsub.publish('REQUEST_PROGRESS', {
                requestProgress: {
                    requestId,
                    status: "succeeded",
                    progress: 1,
                    data: JSON.stringify(response),
                }
            });
        }).catch((error) => {
            state.status = "failed";
            requestDurationEstimator.endRequest();
            pubsub.publish('REQUEST_PROGRESS', {
                requestProgress: {
                    requestId,
                    status: "failed",
                    progress: 1,
                    data: JSON.stringify(error),
                }
            });
        });

        // publish an update every 2 seconds, using the request duration estimator to calculate
        // the percent complete
        do {
            let progress =
                requestDurationEstimator.calculatePercentComplete();

            pubsub.publish('REQUEST_PROGRESS', {
                requestProgress: {
                    requestId,
                    status: "pending",
                    progress,
                    data,
                }
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
