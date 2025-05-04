import ModelPlugin from './modelPlugin.js';
import logger from '../../lib/logger.js';
import { config } from '../../config.js';

class AzureBingPlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
    }
    
    getRequestParameters(text, parameters = {}) {
        const {
            q, // Query string (takes precedence over text parameter)
            responseFilter, // Comma-separated list of answer types to include/exclude
            freshness, // 'day', 'week', 'month', or date range 'YYYY-MM-DD..YYYY-MM-DD'
            answerCount, // Number of top answers to return
            promote, // Comma-separated list of answer types to promote
            count, // Number of webpages to return (default 10)
            safeSearch = 'Moderate', // 'Off', 'Moderate', or 'Strict'
        } = parameters;

        const requestParameters = {
            data: [],
            params: {
                q: q || text, // Use q if provided, otherwise fall back to text
            }
        };

        // Add optional parameters if they exist
        if (responseFilter) {
            requestParameters.params.responseFilter = responseFilter;
        }
        if (freshness) {
            requestParameters.params.freshness = freshness;
        }
        if (answerCount) {
            requestParameters.params.answerCount = answerCount;
        }
        if (promote) {
            requestParameters.params.promote = promote;
        }
        if (count) {
            requestParameters.params.count = count;
        }
        requestParameters.params.safeSearch = safeSearch;

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

        // Step 1: Strip any existing endpoint after version number
        cortexRequest.url = cortexRequest.url.replace(/\/v(\d+\.\d+)\/.*$/, '/v$1');
        
        // Step 2: Add appropriate endpoint based on searchType
        if (parameters.searchType === 'news') {
            cortexRequest.url += '/news/search';
        } else {
            cortexRequest.url += '/search';
        }

        return this.executeRequest(cortexRequest);
    }
    
    parseResponse(data) {
        return JSON.stringify(data);
    }
    
    // Override the logging function to display the request and response
    logRequestData(data, responseData, prompt) {
        //this.logAIRequestFinished();
    
        logger.verbose(`${this.parseResponse(responseData)}`);
    
        prompt && prompt.debugInfo && (prompt.debugInfo += `\n${JSON.stringify(data)}`);
    }
}

export default AzureBingPlugin;
