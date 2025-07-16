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
                to: combinedParameters.to,
                glossaryId: combinedParameters.glossaryId || 'none'
            }
        };
    }

    // Execute the request to the AppTek Translate API
    async execute(text, parameters, prompt, cortexRequest) {
        try {
            const requestParameters = this.getRequestParameters(text, parameters, prompt);
            const { from = 'auto', to } = requestParameters.params;

            let sourceLanguage = from;

            // If source language is 'auto', detect it
            if (from === 'auto') {
                // Assuming requestParameters.data contains the text for language detection (usually same as 'text')
                const detectedLang = await this.detectLanguage(requestParameters.data);
                if (detectedLang) {
                    sourceLanguage = detectedLang;
                    requestParameters.params.from = detectedLang; // Update for subsequent use
                } else {
                    const warnMsg = `ApptekTranslatePlugin: Language detection for 'auto' did not return a language. Proceeding with 'auto' or default.`;
                    logger.warn(warnMsg)
                    // sourceLanguage remains 'auto'. The comparison 'auto' === to will likely be false.
                }
            }
            // At this point, sourceLanguage is either the initially provided 'from' language,
            // or the detected language if 'from' was 'auto' and detection was successful.
            // requestParameters.params.from is also updated if detection occurred.

            // Check if source and target languages are the same
            // Ensure 'to' is a valid language string, not empty or null.
            if (to && sourceLanguage && sourceLanguage !== 'auto' && sourceLanguage === to) {
                const logMessage = `ApptekTranslatePlugin: Source language (${sourceLanguage}) matches target language (${to}). Skipping translation.`;
                logger.verbose(logMessage)
                // Return the original text. Ensure the return format matches what `this.executeRequest`
                // would return for a successful translation (e.g., string or object).
                // Assuming it's a string based on typical translation plugin behavior.
                return text;
            }

            // Construct the URL with the (potentially detected) source language and target language
            const langPair = `${requestParameters.params.from}-${to}`; // requestParameters.params.from is correctly set
            cortexRequest.url = `${this.apiEndpoint}/api/v2/quicktranslate/${langPair}`;
            cortexRequest.data = requestParameters.data; 
            cortexRequest.method = 'POST';
            cortexRequest.headers = {
                'x-token': this.apiKey,
                'Accept': 'application/json',
                'Content-Type': 'text/plain'
            };
            
            // Add glossary_id parameter if it's provided and not 'none'
            if (requestParameters.params.glossaryId && requestParameters.params.glossaryId !== 'none') {
                const url = new URL(cortexRequest.url);
                url.searchParams.append('glossary_id', requestParameters.params.glossaryId);
                cortexRequest.url = url.toString();
                
                const glossaryLogMessage = `ApptekTranslatePlugin: Using glossary ID: ${requestParameters.params.glossaryId}`;
                logger.verbose(glossaryLogMessage)
            }

            return this.executeRequest(cortexRequest);
        } catch (error) {
            // If AppTek translation fails, use Groq as a fallback
            logger.warn(`AppTek translation failed: ${error.message}. Falling back to Groq translate.`);
            
            try {
                // Import the callPathway function if it hasn't been imported at the top
                const { callPathway } = await import('../../lib/pathwayTools.js');
                
                // Call the Groq translate pathway as a fallback
                const result = await callPathway('translate_groq', { 
                    text, 
                    to: parameters.to || this.promptParameters.to,
                });
                
                logger.verbose('Successfully used Groq translate as fallback');
                return result;
            } catch (fallbackError) {
                // If even the fallback fails, log it and rethrow the original error
                logger.error(`Groq translate fallback also failed: ${fallbackError.message}`);
                throw fallbackError;
            }
        }
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
            }else {
                logger.error(`Apptek Language detection failed with status: ${resultResponse.status}`);
                logger.debug({error: resultResponse, text})
            }

            if (!detectedLanguage) {
               throw new Error('Language detection failed');
            }

            return detectedLanguage;

        } catch (error) {
            try {
                // Import the callPathway function if it hasn't been imported at the top
                const { callPathway } = await import('../../lib/pathwayTools.js');
                
                // Call the language pathway as a fallback
                const detectedLanguage = await callPathway('language', { 
                    text,
                });
                
                logger.verbose('Successfully used language pathway as fallback');
                return detectedLanguage;
            } catch (fallbackError) {
                // If even the fallback fails, log it and rethrow the original error
                logger.error(`Language pathway fallback also failed: ${fallbackError.message}`);
                throw fallbackError;
            }
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
