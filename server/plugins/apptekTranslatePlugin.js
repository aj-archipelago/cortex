// ApptekTranslatePlugin.js
import ModelPlugin from './modelPlugin.js';
import logger from '../../lib/logger.js';

class ApptekTranslatePlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
        
        // Get API configuration from environment variables through the base class
        const apiEndpoint = this.environmentVariables.APPTEK_API_ENDPOINT;
        const apiKey = this.environmentVariables.APPTEK_API_KEY;
        
        if (!apiEndpoint || !apiKey) {
            throw new Error('AppTek API configuration missing. Please check APPTEK_API_ENDPOINT and APPTEK_API_KEY environment variables.');
        }

        this.apiEndpoint = apiEndpoint;
        this.apiKey = apiKey;
    }

    // Set up parameters specific to the AppTek Translate API
    getRequestParameters(text, parameters, prompt) {
        const combinedParameters = { ...this.promptParameters, ...parameters };
        const { modelPromptText } = this.getCompiledPrompt(text, parameters, prompt);
        
        // For AppTek, we don't need to wrap the text in an object since it expects raw text
        return {
            data: modelPromptText,
            params: {
                from: combinedParameters.from || 'auto',
                to: combinedParameters.to
            }
        };
    }

    // Execute the request to the AppTek Translate API
    async execute(text, parameters, prompt, cortexRequest) {
        const requestParameters = this.getRequestParameters(text, parameters, prompt);
        const { from = 'auto', to } = requestParameters.params;

        // If source language is 'auto', we need to detect it first
        if (from === 'auto') {
            const detectedLang = await this.detectLanguage(requestParameters.data);
            requestParameters.params.from = detectedLang;
        }

        // Construct the URL with language pair for translation
        const langPair = `${requestParameters.params.from}-${to}`;
        cortexRequest.url = `${this.apiEndpoint}/api/v2/quicktranslate/${langPair}`;
        cortexRequest.data = requestParameters.data;
        cortexRequest.method = 'POST';
        cortexRequest.headers = {
            'x-token': this.apiKey,
            'Accept': 'application/json',
            'Content-Type': 'text/plain'
        };

        return this.executeRequest(cortexRequest);
    }

    // Detect language using AppTek's language detection API
    async detectLanguage(text) {
        try {
            // Make language detection request
            const resultResponse = await fetch(`${this.apiEndpoint}/api/v2/quick_lid`, {
                method: 'POST',
                headers: {
                    'x-token': this.apiKey,
                    'Accept': 'application/json',
                    'Content-Type': 'text/plain'
                },
                body: text
            });

            let detectedLanguage = null;


            if (resultResponse.status === 200) {
                const result = await resultResponse.text();
                detectedLanguage = result.split('\n')[0].split(';')[0];
            }

            if (!detectedLanguage) {
                throw new Error('Language detection timed out');
            }

            return detectedLanguage;

        } catch (error) {
            logger.error('AppTek language detection error:', error);
            throw error;
        }
    }

    // Parse the response from the AppTek Translate API
    parseResponse(data) {
        // AppTek returns the translated text directly
        return data.trim();
    }

    // Override the logging function to display the request and response
    logRequestData(data, responseData, prompt) {
        logger.verbose(`Input: ${data}`);
        logger.verbose(`Output: ${this.parseResponse(responseData)}`);

        if (prompt?.debugInfo) {
            prompt.debugInfo += `\nInput: ${data}\nOutput: ${responseData}`;
        }
    }
}

export default ApptekTranslatePlugin;
