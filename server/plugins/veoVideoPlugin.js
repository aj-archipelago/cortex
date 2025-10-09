import ModelPlugin from "./modelPlugin.js";
import logger from "../../lib/logger.js";
import axios from "axios";

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
      'veo-2.0-generate': 'GA',
      'veo-3.0-generate': 'Preview',
      'veo-3.0-fast-generate': 'Preview'
    };

    // Get the model ID from the pathway or use default
    const model = combinedParameters.model || 'veo-2.0-generate';
    
    if (!availableModels[model]) {
      throw new Error(`Invalid Veo model ID: ${model}. Available models: ${Object.keys(availableModels).join(', ')}`);
    }

    // Validate model-specific parameter constraints
    this.validateModelSpecificParameters(combinedParameters, model);

    // Build the request parameters based on Veo API documentation
    const requestParameters = {
      instances: [
        {
          prompt: modelPromptText,
          // Optional input media fields
          ...(combinedParameters.image && { image: JSON.parse(combinedParameters.image) }),
          // lastFrame and video are only supported in 2.0
          ...(model === 'veo-2.0-generate' && combinedParameters.lastFrame && { lastFrame: JSON.parse(combinedParameters.lastFrame) }),
          ...(model === 'veo-2.0-generate' && combinedParameters.video && { video: JSON.parse(combinedParameters.video) }),
        }
      ],
      parameters: {
        // Generation parameters
        ...(combinedParameters.aspectRatio && { aspectRatio: combinedParameters.aspectRatio }),
        ...(combinedParameters.durationSeconds && { durationSeconds: combinedParameters.durationSeconds }),
        ...(combinedParameters.enhancePrompt !== undefined && { enhancePrompt: combinedParameters.enhancePrompt }),
        // generateAudio is required for 3.0 and not supported by 2.0
        ...(model === 'veo-3.0-generate' && { generateAudio: combinedParameters.generateAudio !== undefined ? combinedParameters.generateAudio : true }),
        ...(model === 'veo-3.0-fast-generate' && { generateAudio: combinedParameters.generateAudio !== undefined ? combinedParameters.generateAudio : true }),
        ...(combinedParameters.negativePrompt && { negativePrompt: combinedParameters.negativePrompt }),
        ...(combinedParameters.personGeneration && { personGeneration: combinedParameters.personGeneration }),
        ...(combinedParameters.sampleCount && { sampleCount: combinedParameters.sampleCount }),
        ...(combinedParameters.seed && Number.isInteger(combinedParameters.seed && combinedParameters.seed > 0) ? { seed: combinedParameters.seed } : {}),
        ...(combinedParameters.storageUri && { storageUri: combinedParameters.storageUri }),
      }
    };

    return requestParameters;
  }

  // Validate model-specific parameter constraints
  validateModelSpecificParameters(parameters, model) {
    // Duration constraints
    if (parameters.durationSeconds !== undefined) {
      if (model === 'veo-3.0-generate' && parameters.durationSeconds !== 8) {
        throw new Error(`Veo 3.0 only supports durationSeconds: 8, got: ${parameters.durationSeconds}`);
      }
      if (model === 'veo-3.0-fast-generate' && parameters.durationSeconds !== 8) {
        throw new Error(`Veo 3.0 only supports durationSeconds: 8, got: ${parameters.durationSeconds}`);
      }
      if (model === 'veo-2.0-generate' && (parameters.durationSeconds < 5 || parameters.durationSeconds > 8)) {
        throw new Error(`Veo 2.0 supports durationSeconds between 5-8, got: ${parameters.durationSeconds}`);
      }
    }

    // lastFrame and video constraints
    if (model === 'veo-3.0-generate') {
      if (parameters.lastFrame) {
        throw new Error('lastFrame parameter is not supported in Veo 3.0');
      }
      if (parameters.video) {
        throw new Error('video parameter is not supported in Veo 3.0');
      }
      if (model === 'veo-3.0-fast-generate' && parameters.lastFrame) {
        throw new Error('lastFrame parameter is not supported in Veo 3.0');
      }
      if (model === 'veo-3.0-fast-generate' && parameters.video) {
        throw new Error('video parameter is not supported in Veo 3.0');
      }
    }

    // generateAudio constraints
    if (model === 'veo-2.0-generate' && parameters.generateAudio) {
      throw new Error('generateAudio parameter is not supported in Veo 2.0');
    }
    if (model === 'veo-3.0-generate' && parameters.generateAudio === undefined) {
      logger.warn('generateAudio is required for Veo 3.0, defaulting to true');
    }
    if (model === 'veo-3.0-fast-generate' && parameters.generateAudio === undefined) {
      logger.warn('generateAudio is required for Veo 3.0, defaulting to true');
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
    const model = parameters.model || 'veo-2.0-generate';
    
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
    const model = this.model || 'veo-2.0-generate';
    const parameters = data?.parameters || {};

    logger.verbose(`Veo Model: ${model}`);
    logger.verbose(`Prompt: ${modelInput}`);
    logger.verbose(`Parameters: ${JSON.stringify(parameters)}`);
    logger.verbose(`Response: ${this.parseResponse(responseData)}`);

    prompt &&
      prompt.debugInfo &&
      (prompt.debugInfo += `\n${JSON.stringify(data)}`);
  }
}

export default VeoVideoPlugin; 