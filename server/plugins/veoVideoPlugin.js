import ModelPlugin from "./modelPlugin.js";
import logger from "../../lib/logger.js";
import axios from "axios";

const parseVeoMediaField = (value, fieldName) => {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${fieldName} must be a JSON media object for Veo requests`);
  }
};

const getReferenceImageMedia = (referenceImage) => {
  if (!referenceImage) return null;
  return referenceImage.image || referenceImage;
};

class VeoVideoPlugin extends ModelPlugin {
  constructor(pathway, model) {
    super(pathway, model);
  }

  // Set up parameters specific to the Veo API
  getRequestParameters(text, parameters, prompt) {
    const combinedParameters = { ...this.promptParameters, ...parameters };
    const { modelPromptText } = this.getCompiledPrompt(
      text,
      parameters,
      prompt,
    );

    // Available Veo models
    const availableModels = {
      'veo-3.1-generate': 'GA',
      'veo-3.1-fast-generate': 'GA',
      'veo-3.1-lite-generate': 'Preview'
    };

    // Get the model ID from the pathway or use default
    const model = combinedParameters.model || 'veo-3.1-generate';
    
    if (!availableModels[model]) {
      throw new Error(`Invalid Veo model ID: ${model}. Available models: ${Object.keys(availableModels).join(', ')}`);
    }

    // Validate model-specific parameter constraints
    this.validateModelSpecificParameters(combinedParameters, model);

    let image = parseVeoMediaField(combinedParameters.image, 'image');
    const lastFrame = parseVeoMediaField(combinedParameters.lastFrame, 'lastFrame');
    const video = parseVeoMediaField(combinedParameters.video, 'video');
    const isVideoExtension = Boolean(video);
    let referenceImages = Array.isArray(combinedParameters.referenceImages)
      ? combinedParameters.referenceImages.slice(0, 3)
      : [];

    if (model === 'veo-3.1-lite-generate' && referenceImages.length > 0) {
      image = image || getReferenceImageMedia(referenceImages[0]);
      referenceImages = [];
    }

    // Build the request parameters based on Veo API documentation
    const requestParameters = {
      instances: [
        {
          prompt: modelPromptText,
          // Optional input media fields
          ...(image && { image }),
          ...(lastFrame && { lastFrame }),
          ...(video && { video }),
          ...(referenceImages.length > 0 ? { referenceImages } : {}),
        }
      ],
      parameters: {
        // Generation parameters
        ...(!isVideoExtension && combinedParameters.aspectRatio && { aspectRatio: combinedParameters.aspectRatio }),
        ...(!isVideoExtension && combinedParameters.durationSeconds && { durationSeconds: combinedParameters.durationSeconds }),
        ...(!isVideoExtension && combinedParameters.enhancePrompt !== undefined && { enhancePrompt: combinedParameters.enhancePrompt }),
        // generateAudio is supported by all current Veo 3.1 models
        generateAudio: combinedParameters.generateAudio !== undefined ? combinedParameters.generateAudio : true,
        ...(combinedParameters.resolution && { resolution: combinedParameters.resolution }),
        ...(!isVideoExtension && combinedParameters.negativePrompt && { negativePrompt: combinedParameters.negativePrompt }),
        ...(!isVideoExtension && combinedParameters.personGeneration && { personGeneration: combinedParameters.personGeneration }),
        ...(!isVideoExtension && combinedParameters.sampleCount && { sampleCount: combinedParameters.sampleCount }),
        ...(!isVideoExtension && combinedParameters.seed && Number.isInteger(combinedParameters.seed && combinedParameters.seed > 0) ? { seed: combinedParameters.seed } : {}),
        ...(combinedParameters.storageUri && { storageUri: combinedParameters.storageUri }),
      }
    };

    return requestParameters;
  }

  // Validate model-specific parameter constraints
  validateModelSpecificParameters(parameters, model) {
    // Duration constraints
    const isVideoExtension = Boolean(parameters.video);
    if (!isVideoExtension && parameters.durationSeconds !== undefined) {
      if (model === 'veo-3.1-lite-generate') {
        const allowedDurations = [4, 6, 8];
        if (!allowedDurations.includes(parameters.durationSeconds)) {
          throw new Error(`Veo 3.1 Lite supports durationSeconds: ${allowedDurations.join(', ')}, got: ${parameters.durationSeconds}`);
        }
      } else if (parameters.durationSeconds !== 8) {
        throw new Error(`${model} only supports durationSeconds: 8, got: ${parameters.durationSeconds}`);
      }
    }

    if (parameters.referenceImages !== undefined) {
      if (!Array.isArray(parameters.referenceImages)) {
        throw new Error('referenceImages must be an array');
      }
      if (parameters.referenceImages.length > 3) {
        throw new Error('Veo supports at most 3 reference images');
      }
    }
  }

  // Execute the request to the Veo API
  async execute(text, parameters, prompt, cortexRequest) {
    const requestParameters = this.getRequestParameters(
      text,
      parameters,
      prompt,
    );

    cortexRequest.data = requestParameters;
    cortexRequest.params = requestParameters.params;

    // Get the model ID for the URL
    const model = parameters.model || 'veo-3.1-generate';
    
    // Use the URL from the model configuration (cortexRequest.url is set by Cortex)
    const baseUrl = cortexRequest.url;
    const predictUrl = `${baseUrl}:predictLongRunning`;

    // Set up the request
    const requestConfig = {
      method: 'POST',
      url: predictUrl,
      headers: {
        'Content-Type': 'application/json',
        ...cortexRequest.headers
      },
      data: requestParameters
    };

    // Get authentication token
    const gcpAuthTokenHelper = this.config.get('gcpAuthTokenHelper');
    const authToken = await gcpAuthTokenHelper.getAccessToken();
    requestConfig.headers.Authorization = `Bearer ${authToken}`;

    logger.info(`Starting Veo video generation with model: ${model}`);

    try {
      // Make initial request to start video generation
      const response = await axios(requestConfig);
      const operationName = response.data.name;

      if (!operationName) {
        throw new Error("No operation name returned from Veo API");
      }

      logger.info(`Veo video generation started. Operation: ${operationName}`);

      // Poll for results
      const maxAttempts = 120; // 10 minutes with 5 second intervals
      const pollInterval = 5000;
      
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          // Poll the operation status
          const pollResponse = await axios.post(
            `${baseUrl}:fetchPredictOperation`,
            { operationName },
            {
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`
              }
            }
          );

          const operationData = pollResponse.data;
          logger.info(`Polling Veo operation ${operationName} - attempt ${attempt + 1}, done: ${operationData.done || false}`);

          if (operationData.done) {
            if (operationData.response && operationData.response.videos) {
              logger.info(`Veo video generation completed successfully`);
              return JSON.stringify(operationData);
            } else {
              throw new Error(`Veo operation completed but no videos returned: ${JSON.stringify(operationData)}`);
            }
          }

          // Wait before next poll
          await new Promise(resolve => setTimeout(resolve, pollInterval));
        } catch (error) {
          logger.error(`Error polling Veo operation: ${error.message}`);
          throw error;
        }
      }

      throw new Error(`Veo video generation timed out after ${maxAttempts * pollInterval / 1000} seconds`);
    } catch (error) {
      logger.error(`Veo video generation failed: ${error.message}`);
      throw error;
    }
  }

  // Parse the response from the Veo API
  parseResponse(data) {
    if (data.response && data.response.videos) {
      // Return the videos array with GCS URIs
      return JSON.stringify({
        videos: data.response.videos,
        operationName: data.name,
        status: 'completed'
      });
    }
    return JSON.stringify(data);
  }

  // Override the logging function to display the request and response
  logRequestData(data, responseData, prompt) {
    const modelInput = data?.instances?.[0]?.prompt;
    const model = this.model || 'veo-3.1-generate';
    const parameters = data?.parameters || {};

    const { length, units } = this.getLength(modelInput || '');
    logger.info(`[Veo request sent to model ${model} containing ${length} ${units}]`);
    logger.info(`[Veo request parameters: ${Object.keys(parameters).join(', ') || 'none'}]`);
    const responseText = this.parseResponse(responseData);
    const responseLength = this.getLength(responseText || '');
    logger.info(`[Veo response received containing ${responseLength.length} ${responseLength.units}]`);

    prompt &&
      prompt.debugInfo &&
      (prompt.debugInfo += `\n${JSON.stringify(data)}`);
  }
}

export default VeoVideoPlugin;
