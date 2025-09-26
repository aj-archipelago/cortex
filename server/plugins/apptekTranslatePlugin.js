// ApptekTranslatePlugin.js
import ModelPlugin from './modelPlugin.js';
import logger from '../../lib/logger.js';
const { callPathway } = await import('../../lib/pathwayTools.js');
                

class ApptekTranslatePlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
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
        const requestParameters = this.getRequestParameters(text, parameters, prompt);
        const { from = 'auto', to } = requestParameters.params;

        let sourceLanguage = from;

        // If source language is 'auto', detect it
        if (from === 'auto') {
            const detectedLang = await this.detectLanguage(requestParameters.data, cortexRequest);
            if (detectedLang) {
                sourceLanguage = detectedLang;
                requestParameters.params.from = detectedLang;
            } else {
                const warnMsg = `ApptekTranslatePlugin: Language detection for 'auto' did not return a language. Proceeding with 'auto' or default.`;
                logger.warn(warnMsg)
            }
        }

        // Check if source and target languages are the same
        if (to && sourceLanguage && sourceLanguage !== 'auto' && sourceLanguage === to) {
            const logMessage = `ApptekTranslatePlugin: Source language (${sourceLanguage}) matches target language (${to}). Skipping translation.`;
            logger.verbose(logMessage)
            return text;
        }

        // Transform the base URL for translation
        const langPair = `${requestParameters.params.from}-${to}`;
        const translateUrl = `${cortexRequest.url}/api/v2/quicktranslate/${langPair}`;
        
        // Set up the request using the standard pattern
        cortexRequest.url = translateUrl;
        cortexRequest.data = requestParameters.data;
        cortexRequest.method = 'POST';
        
        // Add glossary_id parameter if it's provided and not 'none'
        if (requestParameters.params.glossaryId && requestParameters.params.glossaryId !== 'none') {
            const url = new URL(cortexRequest.url);
            url.searchParams.append('glossary_id', requestParameters.params.glossaryId);
            cortexRequest.url = url.toString();
            
            const glossaryLogMessage = `ApptekTranslatePlugin: Using glossary ID: ${requestParameters.params.glossaryId}`;
            logger.verbose(glossaryLogMessage)
        }

        return this.executeRequest(cortexRequest);
    }

    // Detect language using AppTek's language detection API
    async detectLanguage(text, cortexRequest) {
        try {
            // Transform the base URL for language detection
            const detectUrl = `${cortexRequest.url}/api/v2/quick_lid`;
            
            // Make language detection request
            const resultResponse = await fetch(detectUrl, {
                method: 'POST',
                headers: {
                    ...cortexRequest.headers
                },
                body: text
            });

            let detectedLanguage = null;

            if (resultResponse.status === 200) {
                const result = await resultResponse.text();
                detectedLanguage = result.split('\n')[0].split(';')[0];
            } else {
                logger.error(`Apptek Language detection failed with status: ${resultResponse.status}`);
                logger.debug(`Apptek language detection response: ${JSON.stringify({ status: resultResponse.status, textSnippet: text?.slice?.(0, 200) || text })}`)
            }

            if (!detectedLanguage) {
               throw new Error('Language detection failed');
            }

            return detectedLanguage;

        } catch (error) {
            try {
                // Call the language pathway as a fallback
                const detectedLanguage = await callPathway('language', { 
                    text,
                });
                
                logger.verbose(`Successfully used language pathway as fallback: ${JSON.stringify({ detectedLanguage })}`);
                if (!detectedLanguage) {
                    throw new Error('Language detection failed using fallback language pathway');
                }
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
