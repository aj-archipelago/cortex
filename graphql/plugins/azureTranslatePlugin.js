// AzureTranslatePlugin.js
const ModelPlugin = require('./modelPlugin');
const handlebars = require("handlebars");

class AzureTranslatePlugin extends ModelPlugin {
    constructor(config, modelName, pathway) {
        super(config, modelName, pathway);
    }

    // Set up parameters specific to the Azure Translate API
    requestParameters(text, parameters, prompt) {
        const combinedParameters = { ...this.promptParameters, ...parameters };
        const modelPrompt = this.getModelPrompt(prompt, parameters);
        const modelPromptText = modelPrompt.prompt ? handlebars.compile(modelPrompt.prompt)({ ...combinedParameters, text }) : '';

        return {
            data: [
                {
                Text: modelPromptText,
                },
            ],
            params: {
                to: combinedParameters.to
            }
        };
    }

    // Execute the request to the Azure Translate API
    async execute(text, parameters, prompt) {
        const requestParameters = this.requestParameters(text, parameters, prompt);

        const url = this.requestUrl(text);

        const data = requestParameters.data;
        const params = requestParameters.params;
        const headers = this.model.headers || {};

        return this.executeRequest(url, data, params, headers);
    }
}

module.exports = AzureTranslatePlugin;
