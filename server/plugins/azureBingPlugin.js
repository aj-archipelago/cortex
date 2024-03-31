import ModelPlugin from './modelPlugin.js';
import logger from '../../lib/logger.js';
import { config } from '../../config.js';

class AzureBingPlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
    }
    
    getRequestParameters(text) {
        const requestParameters = {
            data: [
            ],
            params: {
                q: text,
            }
        };
        return requestParameters;
    }

    async execute(text, parameters, prompt, cortexRequest) {
        if(!config.getEnv()["AZURE_BING_KEY"]){
            throw new Error("AZURE_BING_KEY is not set in the environment variables!");
        }
        const requestParameters = this.getRequestParameters(text, parameters, prompt);

        cortexRequest.data = requestParameters.data;
        cortexRequest.params = requestParameters.params;
        cortexRequest.method = 'GET';

        return this.executeRequest(cortexRequest);
    }
    
    parseResponse(data) {
        return JSON.stringify(data);
    }
    
    // Override the logging function to display the request and response
    logRequestData(data, responseData, prompt) {
        this.logAIRequestFinished();
    
        logger.debug(`${this.parseResponse(responseData)}`);
    
        prompt && prompt.debugInfo && (prompt.debugInfo += `\n${JSON.stringify(data)}`);
    }
}

export default AzureBingPlugin;
