// OpenAIImagePlugin.js
import FormData from 'form-data';
import { config } from '../../config.js';
import ModelPlugin from './modelPlugin.js';
import pubsub from '../pubsub.js';
import axios from 'axios';
import RequestDurationEstimator from '../../lib/requestDurationEstimator.js';
import logger from '../../lib/logger.js';

const requestDurationEstimator = new RequestDurationEstimator(10);

class OpenAIImagePlugin extends ModelPlugin {
    constructor(config, pathway, modelName, model) {
        super(config, pathway, modelName, model);
    }

    // Implement the method to call the DALL-E API
    async execute(text, parameters, _, pathwayResolver) {
        const url = this.requestUrl(text);
        const data = JSON.stringify({ prompt: text });

        let id;
        const { requestId, pathway } = pathwayResolver;

        try {
            requestDurationEstimator.startRequest(requestId);
            id = (await this.executeRequest(url, data, {}, { ...this.model.headers }, {}, requestId, pathway))?.id;
        } catch (error) {
            const errMsg = `Error generating image: ${error?.message || JSON.stringify(error)}`;
            logger.error(errMsg);
            return errMsg;
        }

        if (!parameters.async) {
            return await this.getStatus(text, id, requestId);
        }
        else {
            this.getStatus(text, id, requestId);
        }
    }

    async getStatus(text, id, requestId) {
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
                requestDurationEstimator.calculatePercentComplete();

            if (status === "succeeded") {
                progress = 1;
                data = JSON.stringify(response);
            }

            pubsub.publish('REQUEST_PROGRESS', {
                requestProgress: {
                    requestId,
                    status,
                    progress,
                    data,
                }
            });

            if (status === "succeeded") {
                requestDurationEstimator.endRequest();
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
