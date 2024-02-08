// CohereSummarizePlugin.js
import ModelPlugin from './modelPlugin.js';

class CohereSummarizePlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
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
    async execute(text, parameters, prompt, cortexRequest) {
        const requestParameters = this.getRequestParameters(text, parameters, prompt);
        cortexRequest.data = { ...cortexRequest.data, ...requestParameters };
        return this.executeRequest(cortexRequest);
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