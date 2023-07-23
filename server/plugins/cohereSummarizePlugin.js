// CohereSummarizePlugin.js
import ModelPlugin from './modelPlugin.js';

class CohereSummarizePlugin extends ModelPlugin {
    constructor(config, pathway, modelName, model) {
        super(config, pathway, modelName, model);
    }

    // Set up parameters specific to the Cohere Summarize API
    getRequestParameters(text, parameters, prompt) {
        const { modelPromptText } = this.getCompiledPrompt(text, parameters, prompt);

        const requestParameters = {
            length: parameters.length || "medium",
            format: parameters.format || "paragraph",
            model: "summarize-xlarge",
            extractiveness: parameters.extractiveness || "low",
            temperature: this.temperature ?? 0.3,
            text: modelPromptText
        };
    
        return requestParameters;
    }

    // Execute the request to the Cohere Summarize API
    async execute(text, parameters, prompt, pathwayResolver) {
        const url = this.requestUrl();
        const requestParameters = this.getRequestParameters(text, parameters, prompt);
        const { requestId, pathway} = pathwayResolver;

        const data = { ...(this.model.params || {}), ...requestParameters };
        const params = {};
        const headers = { 
            ...this.model.headers || {}
        };
        return this.executeRequest(url, data, params, headers, prompt, requestId, pathway);
    }

    // Parse the response from the Cohere Summarize API
    parseResponse(data) {
        const { summary } = data;
        if (!summary) {
            return data;
        }
        // Return the summary
        return summary;
    }
}

export default CohereSummarizePlugin;