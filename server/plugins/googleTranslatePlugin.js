// GoogleTranslatePlugin.js
import ModelPlugin from './modelPlugin.js';
import logger from '../../lib/logger.js';

class GoogleTranslatePlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
        
        // Get API configuration from environment variables through the base class
        const projectId = this.environmentVariables.GOOGLE_CLOUD_PROJECT_ID;
        const apiKey = this.environmentVariables.GOOGLE_CLOUD_API_KEY;
        
        if (!projectId && !apiKey) {
            throw new Error('Google Cloud Translation API configuration missing. Please check GOOGLE_CLOUD_PROJECT_ID or GOOGLE_CLOUD_API_KEY environment variables.');
        }

        this.projectId = projectId;
        this.apiKey = apiKey;
        this.location = this.environmentVariables.GOOGLE_CLOUD_LOCATION || 'global';
    }

    // Set up parameters specific to the Google Translate API
    getRequestParameters(text, parameters, prompt) {
        const combinedParameters = { ...this.promptParameters, ...parameters };
        const { modelPromptText } = this.getCompiledPrompt(text, parameters, prompt);

        
        const requestParameters = {
            data: {
                q: [modelPromptText],
                target: combinedParameters.to
            },
            params: {}
        };

        // Add source language if provided and not 'auto'
        if (combinedParameters.from && combinedParameters.from !== 'auto') {
            requestParameters.data.source = combinedParameters.from;
        }

        // Configure API version - v2 is simpler for basic translation
        if (this.apiKey) {
            // Using API key authentication (v2 API)
            requestParameters.params.key = this.apiKey;
        } else {
            // Using OAuth with project ID (v3 API)
            requestParameters.data.parent = `projects/${this.projectId}/locations/${this.location}`;
        }

        return requestParameters;
    }

    // Execute the request to the Google Translate API
    async execute(text, parameters, prompt, cortexRequest) {
        const requestParameters = this.getRequestParameters(text, parameters, prompt);
        
        // Configure the API version based on authentication method
        if (this.apiKey) {
            // Using API key authentication (v2 API)
            cortexRequest.url = 'https://translation.googleapis.com/language/translate/v2';
            cortexRequest.method = 'POST';
            cortexRequest.data = requestParameters.data;
            cortexRequest.params = requestParameters.params;
            cortexRequest.headers = {
                'Content-Type': 'application/json'
            };
        } else {
            // Using OAuth with project ID (v3 API)
            cortexRequest.url = `https://translation.googleapis.com/v3/projects/${this.projectId}/locations/${this.location}:translateText`;
            cortexRequest.method = 'POST';
            cortexRequest.data = {
                contents: requestParameters.data.q,
                targetLanguageCode: requestParameters.data.target,
                sourceLanguageCode: requestParameters.data.source,
                mimeType: 'text/plain',
            };
            cortexRequest.headers = {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${await this.getAccessToken()}`
            };
        }

        return this.executeRequest(cortexRequest);
    }
    
    // Get access token for OAuth authentication
    async getAccessToken() {
        // This would be implemented if using OAuth authentication
        // For simplicity, we recommend using API key authentication
        return null;
    }
    
    // Parse the response from the Google Translate API
    parseResponse(data) {
        // Handle v2 API response
        if (data && data.data && data.data.translations) {
            return data.data.translations[0].translatedText.trim();
        }
        // Handle v3 API response
        else if (data && data.translations) {
            return data.translations[0].translatedText.trim();
        } else {
            return data;
        }
    }

    // Override the logging function to display the request and response
    logRequestData(data, responseData, prompt) {
        const modelInput = data.q ? data.q[0] : (data.contents ? data.contents[0] : '');
        const translatedText = this.parseResponse(responseData);
        
        logger.verbose(`Input: ${modelInput}`);
        logger.verbose(`Output: ${translatedText}`);

        if (prompt?.debugInfo) {
            prompt.debugInfo += `\nInput: ${modelInput}\nOutput: ${translatedText}`;
        }
    }
}

export default GoogleTranslatePlugin;