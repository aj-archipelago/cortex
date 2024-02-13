// CohereGeneratePlugin.js
import ModelPlugin from './modelPlugin.js';

class CohereGeneratePlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
    }

    // Set up parameters specific to the Cohere API
    getRequestParameters(text, parameters, prompt) {
        let { modelPromptText, tokenLength } = this.getCompiledPrompt(text, parameters, prompt);

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
    async execute(text, parameters, prompt, cortexRequest) {
        const requestParameters = this.getRequestParameters(text, parameters, prompt);
        cortexRequest.data = { ...cortexRequest.data, ...requestParameters };
        return this.executeRequest(cortexRequest);
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