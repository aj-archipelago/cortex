// AzureTranslatePlugin.js
import ModelPlugin from './modelPlugin.js';
import logger from '../../lib/logger.js';

class AzureTranslatePlugin extends ModelPlugin {
    constructor(config, pathway, modelName, model) {
        super(config, pathway, modelName, model);
    }
    
    // Set up parameters specific to the Azure Translate API
    getRequestParameters(text, parameters, prompt) {
        const combinedParameters = { ...this.promptParameters, ...parameters };
        const { modelPromptText } = this.getCompiledPrompt(text, parameters, prompt);
        const requestParameters = {
            data: [
                {
                Text: modelPromptText,
                },
            ],
            params: {
                to: combinedParameters.to
            }
        };
        return requestParameters;
    }

    // Execute the request to the Azure Translate API
    async execute(text, parameters, prompt, pathwayResolver) {
        const requestParameters = this.getRequestParameters(text, parameters, prompt);
        const { requestId, pathway} = pathwayResolver;

        const url = this.requestUrl(text);

        const data = requestParameters.data;
        const params = requestParameters.params;
        const headers = this.model.headers || {};

        return this.executeRequest(url, data, params, headers, prompt, requestId, pathway);
    }
    
    // Parse the response from the Azure Translate API
    parseResponse(data) {
        if (Array.isArray(data) && data.length > 0 && data[0].translations) {
            return data[0].translations[0].text.trim();
        } else {
            return data;
        }
    }
    
    // Override the logging function to display the request and response
    logRequestData(data, responseData, prompt) {
        this.logAIRequestFinished();
    
        const modelInput = data[0].Text;
    
        logger.debug(`${modelInput}`);
        logger.debug(`${this.parseResponse(responseData)}`);
    
        prompt && prompt.debugInfo && (prompt.debugInfo += `\n${JSON.stringify(data)}`);
    }
}

export default AzureTranslatePlugin;
