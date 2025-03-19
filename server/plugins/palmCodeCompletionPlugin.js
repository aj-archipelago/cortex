// palmCodeCompletionPlugin.js

import PalmCompletionPlugin from './palmCompletionPlugin.js';

// PalmCodeCompletionPlugin class for handling requests and responses to the PaLM API Code Completion API
class PalmCodeCompletionPlugin extends PalmCompletionPlugin {
    constructor(pathway, model) {
        super(pathway, model);
    }

    // Set up parameters specific to the PaLM API Code Completion API
    getRequestParameters(text, parameters, prompt, pathwayResolver) {
        const { modelPromptText, tokenLength } = this.getCompiledPrompt(text, parameters, prompt);
        // Define the model's max token length
        const modelTargetTokenLength = this.getModelMaxPromptTokens();
    
        const truncatedPrompt = this.truncatePromptIfNecessary(modelPromptText, tokenLength, this.getModelMaxTokenLength(), modelTargetTokenLength, pathwayResolver);
    
        const max_tokens = this.getModelMaxReturnTokens();
    
        if (max_tokens < 0) {
            throw new Error(`Prompt is too long to successfully call the model at ${tokenLength} tokens.  The model will not be called.`);
        }

        if (!truncatedPrompt) {
            throw new Error(`Prompt is empty.  The model will not be called.`);
        }
    
        const requestParameters = {
            instances: [
                { prefix: truncatedPrompt }
            ],
            parameters: {
                temperature: this.temperature ?? 0.7,
                maxOutputTokens: max_tokens,
                topP: parameters.topP ?? 0.95,
                topK: parameters.topK ?? 40,
            }
        };
    
        return requestParameters;
    }
}

export default PalmCodeCompletionPlugin;