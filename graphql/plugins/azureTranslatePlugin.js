// AzureTranslatePlugin.js
const ModelPlugin = require('./modelPlugin');

class AzureTranslatePlugin extends ModelPlugin {
    constructor(config, pathway) {
        super(config, pathway);
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
    async execute(text, parameters, prompt) {
        const requestParameters = this.getRequestParameters(text, parameters, prompt);

        const url = this.requestUrl(text);

        const data = requestParameters.data;
        const params = requestParameters.params;
        const headers = this.model.headers || {};

        return this.executeRequest(url, data, params, headers, prompt);
    }
}

module.exports = AzureTranslatePlugin;
