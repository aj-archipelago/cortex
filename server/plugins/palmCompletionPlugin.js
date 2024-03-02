// palmCompletionPlugin.js

import ModelPlugin from './modelPlugin.js';
import logger from '../../lib/logger.js';

// PalmCompletionPlugin class for handling requests and responses to the PaLM API Text Completion API
class PalmCompletionPlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
    }

    truncatePromptIfNecessary (text, textTokenCount, modelMaxTokenCount, targetTextTokenCount, pathwayResolver) {
        const maxAllowedTokens = textTokenCount + ((modelMaxTokenCount - targetTextTokenCount) * 0.5);
    
        if (textTokenCount > maxAllowedTokens) {
            pathwayResolver.logWarning(`Prompt is too long at ${textTokenCount} tokens (this target token length for this pathway is ${targetTextTokenCount} tokens because the response is expected to take up the rest of the model's max tokens (${modelMaxTokenCount}). Prompt will be truncated.`);
            return pathwayResolver.truncate(text, maxAllowedTokens);
        }
        return text;
    }
    // Set up parameters specific to the PaLM API Text Completion API
    getRequestParameters(text, parameters, prompt, pathwayResolver) {
        const { modelPromptText, tokenLength } = this.getCompiledPrompt(text, parameters, prompt);
        
        // Define the model's max token length
        const modelTargetTokenLength = this.getModelMaxTokenLength() * this.getPromptTokenRatio();
    
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
                { prompt: truncatedPrompt }
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

    // Execute the request to the PaLM API Text Completion API
    async execute(text, parameters, prompt, cortexRequest) {
        const requestParameters = this.getRequestParameters(text, parameters, prompt, cortexRequest.pathwayResolver);

        cortexRequest.data = { ...(cortexRequest.data || {}), ...requestParameters };
        cortexRequest.params = {}; // query params

        const gcpAuthTokenHelper = this.config.get('gcpAuthTokenHelper');
        const authToken = await gcpAuthTokenHelper.getAccessToken();
        cortexRequest.headers.Authorization = `Bearer ${authToken}`;

        return this.executeRequest(cortexRequest);
    }

    // Parse the response from the PaLM API Text Completion API
    parseResponse(data) {
        const { predictions } = data;
        if (!predictions || !predictions.length) {
            return data;
        }

        // if we got a predictions array back with more than one prediction, return the whole array
        if (predictions.length > 1) {
            return predictions;
        }

        // otherwise, return the content of the first prediction
        // if it was blocked, return the blocked message
        if (predictions[0].safetyAttributes?.blocked) {
            return 'The response is blocked because the input or response potentially violates Google policies. Try rephrasing the prompt or adjusting the parameter settings. Currently, only English is supported.';
        }

        const contentResult = predictions[0].content && predictions[0].content.trim();
        return contentResult ?? null;
    }

    // Get the safetyAttributes from the PaLM API Text Completion API response data
    getSafetyAttributes(data) {
        const { predictions } = data;
        if (!predictions || !predictions.length) {
            return null;
        }

        // if we got a predictions array back with more than one prediction, return the safetyAttributes of the first prediction
        if (predictions.length > 1) {
            return predictions[0].safetyAttributes ?? null;
        }

        // otherwise, return the safetyAttributes of the content of the first prediction
        return predictions[0].safetyAttributes ?? null;
    }

    // Override the logging function to log the prompt and response
    logRequestData(data, responseData, prompt) {
        const safetyAttributes = this.getSafetyAttributes(responseData);

        const instances = data && data.instances;
        const modelInput = instances && instances[0] && instances[0].prompt;

        if (modelInput) {
            const { length, units } = this.getLength(modelInput);
            logger.info(`[request sent containing ${length} ${units}]`);
            logger.debug(`${modelInput}`);
        }

        const responseText = this.parseResponse(responseData);
        const { length, units } = this.getLength(responseText);
        logger.info(`[response received containing ${length} ${units}]`);
        logger.debug(`${responseText}`);

        if (safetyAttributes) {
            logger.warn(`[response contains safety attributes: ${JSON.stringify(safetyAttributes, null, 2)}]`);
        }

        if (prompt && prompt.debugInfo) {
            prompt.debugInfo += `\n${JSON.stringify(data)}`;
        }
    }
}

export default PalmCompletionPlugin;