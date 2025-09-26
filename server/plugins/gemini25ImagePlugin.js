import Gemini15VisionPlugin from './gemini15VisionPlugin.js';
import logger from '../../lib/logger.js';
import CortexResponse from '../../lib/cortexResponse.js';

class Gemini25ImagePlugin extends Gemini15VisionPlugin {

    constructor(pathway, model) {
        super(pathway, model);
    }

    // Override getRequestParameters to add Gemini 2.5 specific response_modalities support
    getRequestParameters(text, parameters, prompt, cortexRequest) {
        const baseParameters = super.getRequestParameters(text, parameters, prompt, cortexRequest);
        
        // Add Gemini 2.5 specific response_modalities support
        let responseModalities = parameters?.response_modalities;
        if (typeof responseModalities === 'string') {
            try {
                responseModalities = JSON.parse(responseModalities);
            } catch (e) {
                responseModalities = null;
            }
        }

        // Also check pathway parameters
        if (!responseModalities && cortexRequest?.pathway?.response_modalities) {
            responseModalities = cortexRequest.pathway.response_modalities;
        }

        // Set up generation_config with response_modalities if specified
        if (responseModalities && Array.isArray(responseModalities)) {
            baseParameters.generationConfig.response_modalities = responseModalities;
        }

        return baseParameters;
    }


    // Override parseResponse to add Gemini 2.5 image artifact support
    parseResponse(data) {
        // First, let the parent Gemini15VisionPlugin handle the response
        const baseResponse = super.parseResponse(data);
        
        // If the parent already created a CortexResponse (for tool calls, safety blocks, etc.),
        // we need to add image artifacts to it
        if (baseResponse && typeof baseResponse === 'object' && baseResponse.constructor && baseResponse.constructor.name === 'CortexResponse') {
            // Check for image artifacts in the raw data
            if (data?.candidates?.[0]?.content?.parts) {
                const parts = data.candidates[0].content.parts;
                let imageContent = [];

                for (const part of parts) {
                    if (part.inlineData) {
                        // Handle generated image content
                        imageContent.push({
                            type: "image",
                            data: part.inlineData.data,
                            mimeType: part.inlineData.mimeType
                        });
                    }
                }

                // If we have image artifacts, add them to the existing CortexResponse
                if (imageContent.length > 0) {
                    baseResponse.artifacts = imageContent;
                }
            }
            
            return baseResponse;
        }
        
        // If the parent returned a string or other non-CortexResponse, check for image artifacts
        if (data?.candidates?.[0]?.content?.parts) {
            const parts = data.candidates[0].content.parts;
            let imageContent = [];
            let textContent = '';

            for (const part of parts) {
                if (part.inlineData) {
                    // Handle generated image content
                    imageContent.push({
                        type: "image",
                        data: part.inlineData.data,
                        mimeType: part.inlineData.mimeType
                    });
                } else if (part.text) {
                    textContent += part.text;
                }
            }

            // If we have image artifacts, create a new CortexResponse object
            if (imageContent.length > 0) {
                return new CortexResponse({
                    output_text: textContent || baseResponse || '',
                    artifacts: imageContent,
                    finishReason: data?.candidates?.[0]?.finishReason || 'stop',
                    usage: data?.usage || null
                });
            }
        }

        return baseResponse;
    }


    // Override processStreamEvent to add Gemini 2.5 image artifact streaming
    processStreamEvent(event, requestProgress) {
        const baseProgress = super.processStreamEvent(event, requestProgress);
        
        // Add image artifact streaming for Gemini 2.5
        const eventData = JSON.parse(event.data);
        if (eventData.candidates?.[0]?.content?.parts) {
            const parts = eventData.candidates[0].content.parts;
            
            for (const part of parts) {
                if (part.inlineData) {
                    // Handle generated image content in streaming
                    // For now, we'll accumulate images and send them at the end
                    // This could be enhanced to stream image data if needed
                    if (!requestProgress.artifacts) {
                        requestProgress.artifacts = [];
                    }
                    const inlineData = part.inlineData;
                    requestProgress.artifacts.push({
                        type: "image",
                        data: inlineData.data,
                        mimeType: inlineData.mimeType
                    });
                }
            }
        }

        return baseProgress;
    }

    // Override logRequestData to properly handle CortexResponse objects
    logRequestData(data, responseData, prompt) {
        // Check if responseData is a CortexResponse object
        if (responseData && typeof responseData === 'object' && responseData.constructor && responseData.constructor.name === 'CortexResponse') {
            const { length, units } = this.getLength(responseData.output_text || '');
            logger.info(`[response received containing ${length} ${units}]`);
            if (responseData.artifacts && responseData.artifacts.length > 0) {
                logger.info(`[response contains ${responseData.artifacts.length} image artifact(s)]`);
            }
            logger.verbose(`${this.shortenContent(responseData.output_text || '')}`);
            return;
        }

        // Fall back to parent implementation for non-CortexResponse objects
        super.logRequestData(data, responseData, prompt);
    }

}

export default Gemini25ImagePlugin;
