// OpenAIImagePlugin.js
import ModelPlugin from './modelPlugin.js';
import axios from 'axios';
import RequestMonitor from '../../lib/requestMonitor.js';
import { publishRequestProgress } from '../../lib/redisSubscription.js';
import logger from '../../lib/logger.js';

const requestDurationEstimator = new RequestMonitor(10);

class OpenAIImagePlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
    }

    // Implement the method to call the DALL-E API
    async execute(text, parameters, _, cortexRequest) {
        const { pathwayResolver } = cortexRequest;
        cortexRequest.data = JSON.stringify({ prompt: text });

        let id;
        const { requestId } = pathwayResolver;

        let callid;

        try {
            callid = requestDurationEstimator.startCall();
            await this.executeRequest(cortexRequest);
            id = cortexRequest.requestId;

        } catch (error) {
            const errMsg = `Error generating image: ${error?.message || error}`;
            logger.error(errMsg);
            return errMsg;
        }

        if (!parameters.async) {
            return await this.getStatus(text, id, requestId, callid);
        }
        else {
            this.getStatus(text, id, requestId, callid);
        }
    }

    async getStatus(text, id, requestId, callid) {
        // get the post URL which is used to send the request
        const url = this.requestUrl(text);

        // conver it to the GET URL which is used to check the status
        const statusUrl = url.replace("images/generations:submit", `operations/images/${id}`);
        let status;
        let attemptCount = 0;
        let data = null;

        do {
            const response = (await axios.get(statusUrl, { cache: false, headers: { ...this.model.headers } })).data;
            status = response.status;
            let progress = 
                requestDurationEstimator.calculatePercentComplete(callid);

            if (status === "succeeded") {
                progress = 1;
                data = JSON.stringify(response);
            }

            await publishRequestProgress({
                    requestId,
                    status,
                    progress,
                    data,
            });

            if (status === "succeeded") {
                requestDurationEstimator.endCall(callid);
                break;
            }
            // sleep for 5 seconds
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        while (status !== "succeeded" && attemptCount++ < 30);

        return data;
    }
}

export default OpenAIImagePlugin;
