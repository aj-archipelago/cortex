// CohereGeneratePlugin.js
import ModelPlugin from './modelPlugin.js';

class CohereGeneratePlugin extends ModelPlugin {
    constructor(config, pathway, modelName, model) {
        super(config, pathway, modelName, model);
    }

    // Set up parameters specific to the Cohere API
    getRequestParameters(text, parameters, prompt) {
        const { modelPromptText, tokenLength } = this.getCompiledPrompt(text, parameters, prompt);

        // Define the model's max token length
        const modelTargetTokenLength = this.getModelMaxTokenLength() * this.getPromptTokenRatio();
    
        // Check if the token length exceeds the model's max token length
        if (tokenLength > modelTargetTokenLength) {
            // Truncate the prompt text to fit within the token length
            modelPromptText = modelPromptText.substring(0, modelTargetTokenLength);
        }
    
        const requestParameters = {
            model: "command",
            prompt: modelPromptText,
            max_tokens: this.getModelMaxReturnTokens(),
            temperature: this.temperature ?? 0.7,
            k: 0,
            stop_sequences: parameters.stop_sequences || [],
            return_likelihoods: parameters.return_likelihoods || "NONE"
        };
    
        return requestParameters;
    }

    // Execute the request to the Cohere API
    async execute(text, parameters, prompt, pathwayResolver) {
        const url = this.requestUrl();
        const requestParameters = this.getRequestParameters(text, parameters, prompt);
        const requestId = pathwayResolver?.requestId;

        const data = { ...(this.model.params || {}), ...requestParameters };
        const params = {};
        const headers = { 
            ...this.model.headers || {}
        };
        return this.executeRequest(url, data, params, headers, prompt, requestId);
    }

    // Parse the response from the Cohere API
    parseResponse(data) {
        const { generations } = data;
        if (!generations || !generations.length) {
            return data;
        }
        // Return the text of the first generation
        return generations[0].text || null;
    }
}

export default CohereGeneratePlugin;