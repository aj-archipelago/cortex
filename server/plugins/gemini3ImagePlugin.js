import Gemini25ImagePlugin from './gemini25ImagePlugin.js';
import logger from '../../lib/logger.js';

class Gemini3ImagePlugin extends Gemini25ImagePlugin {

    constructor(pathway, model) {
        super(pathway, model);
    }

    // Override getRequestParameters to add Gemini 3 specific image_config support
    getRequestParameters(text, parameters, prompt, cortexRequest) {
        const baseParameters = super.getRequestParameters(text, parameters, prompt, cortexRequest);
        
        // Add Gemini 3 specific image_config support (aspectRatio and image_size)
        // Convert camelCase aspectRatio to snake_case aspect_ratio for API
        let aspectRatio = parameters?.aspectRatio || parameters?.aspect_ratio;
        let imageSize = parameters?.image_size;

        // Also check pathway parameters
        if (!aspectRatio && cortexRequest?.pathway?.aspectRatio) {
            aspectRatio = cortexRequest.pathway.aspectRatio;
        } else if (!aspectRatio && cortexRequest?.pathway?.aspect_ratio) {
            aspectRatio = cortexRequest.pathway.aspect_ratio;
        }
        if (!imageSize && cortexRequest?.pathway?.image_size) {
            imageSize = cortexRequest.pathway.image_size;
        }

        // Set up image_config in generationConfig if either parameter is specified
        if (aspectRatio || imageSize) {
            if (!baseParameters.generationConfig.image_config) {
                baseParameters.generationConfig.image_config = {};
            }
            if (aspectRatio) {
                baseParameters.generationConfig.image_config.aspect_ratio = aspectRatio;
            }
            if (imageSize) {
                baseParameters.generationConfig.image_config.image_size = imageSize;
            }
        }

        return baseParameters;
    }

}

export default Gemini3ImagePlugin;

