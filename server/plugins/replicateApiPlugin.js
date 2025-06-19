// replicateApiPlugin.js
import ModelPlugin from "./modelPlugin.js";
import logger from "../../lib/logger.js";
import axios from "axios";

class ReplicateApiPlugin extends ModelPlugin {
  constructor(pathway, model) {
    super(pathway, model);
  }

  // Set up parameters specific to the Replicate API
  getRequestParameters(text, parameters, prompt) {
    const combinedParameters = { ...this.promptParameters, ...parameters };
    const { modelPromptText } = this.getCompiledPrompt(
      text,
      parameters,
      prompt,
    );

    let requestParameters = {};

    switch (combinedParameters.model) {
      case "replicate-flux-11-pro":
        requestParameters = {
          input: {
            aspect_ratio: combinedParameters.aspectRatio || "1:1",
            output_format: combinedParameters.outputFormat || "webp",
            output_quality: combinedParameters.outputQuality || 80,
            prompt: modelPromptText,
            prompt_upsampling: combinedParameters.promptUpsampling || false,
            safety_tolerance: combinedParameters.safety_tolerance || 3,
            go_fast: true,
            megapixels: "1",
            width: combinedParameters.width,
            height: combinedParameters.height,
            size: combinedParameters.size || "1024x1024",
            style: combinedParameters.style || "realistic_image",
          },
        };
        break;
      case "replicate-recraft-v3": {
        const validStyles = [
          'any',
          'realistic_image',
          'digital_illustration',
          'digital_illustration/pixel_art',
          'digital_illustration/hand_drawn',
          'digital_illustration/grain',
          'digital_illustration/infantile_sketch',
          'digital_illustration/2d_art_poster',
          'digital_illustration/handmade_3d',
          'digital_illustration/hand_drawn_outline',
          'digital_illustration/engraving_color',
          'digital_illustration/2d_art_poster_2',
          'realistic_image/b_and_w',
          'realistic_image/hard_flash',
          'realistic_image/hdr',
          'realistic_image/natural_light',
          'realistic_image/studio_portrait',
          'realistic_image/enterprise',
          'realistic_image/motion_blur'
        ];

        requestParameters = {
          input: {
            prompt: modelPromptText,
            size: combinedParameters.size || "1024x1024",
            style: validStyles.includes(combinedParameters.style) ? combinedParameters.style : "realistic_image",
          },
        };
        break;
      }
      case "replicate-flux-1-schnell": {
        const validRatios = [
          '1:1', '16:9', '21:9', '3:2', '2:3', '4:5',
          '5:4', '3:4', '4:3', '9:16', '9:21'
        ];

        requestParameters = {
          input: {
            aspect_ratio: validRatios.includes(combinedParameters.aspectRatio) ? combinedParameters.aspectRatio : "1:1",
            output_format: combinedParameters.outputFormat || "webp",
            output_quality: combinedParameters.outputQuality || 80,
            prompt: modelPromptText,
            go_fast: true,
            megapixels: "1",
            num_outputs: combinedParameters.numberResults,
            num_inference_steps: combinedParameters.steps || 4,
            disable_safety_checker: true,
          },
        };
        break;
      }
      case "replicate-flux-kontext-pro":
      case "replicate-flux-kontext-max": {
        const validRatios = [
          '1:1', '16:9', '21:9', '3:2', '2:3', '4:5',
          '5:4', '3:4', '4:3', '9:16', '9:21', 'match_input_image'
        ];

        requestParameters = {
          input: {
            prompt: modelPromptText,
            input_image: combinedParameters.input_image,
            aspect_ratio: validRatios.includes(combinedParameters.aspectRatio) ? combinedParameters.aspectRatio : "1:1",
            safety_tolerance: (combinedParameters.input_image ? 2 : combinedParameters.safety_tolerance || 3),
          },
        };
        break;
      }
      case "replicate-multi-image-kontext-max": {
        const validRatios = [
          '1:1', '16:9', '21:9', '3:2', '2:3', '4:5',
          '5:4', '3:4', '4:3', '9:16', '9:21', 'match_input_image'
        ];

        requestParameters = {
          input: {
            prompt: modelPromptText,
            input_image_1: combinedParameters.input_image_1 || combinedParameters.input_image,
            input_image_2: combinedParameters.input_image_2,
            aspect_ratio: validRatios.includes(combinedParameters.aspectRatio) ? combinedParameters.aspectRatio : "1:1",
            safety_tolerance: (combinedParameters.input_image ? 2 : combinedParameters.safety_tolerance || 3),
          },
        };
        break;
      }
    }

    return requestParameters;
  }

  // Execute the request to the Replicate API
  async execute(text, parameters, prompt, cortexRequest) {
    const requestParameters = this.getRequestParameters(
      text,
      parameters,
      prompt,
    );

    cortexRequest.data = requestParameters;
    cortexRequest.params = requestParameters.params;

    // Make initial request to start prediction
    const stringifiedResponse = await this.executeRequest(cortexRequest);
    const parsedResponse = JSON.parse(stringifiedResponse);

    // If we got a completed response, return it
    if (parsedResponse?.status === "succeeded") {
      return stringifiedResponse;
    }
    
    logger.info("Replicate API returned a non-completed response.");

    if (!parsedResponse?.id) {
      throw new Error("No prediction ID returned from Replicate API");
    }

    // Get the prediction ID and polling URL
    const predictionId = parsedResponse.id;
    const pollUrl = parsedResponse.urls?.get;

    if (!pollUrl) {
      throw new Error("No polling URL returned from Replicate API");
    }

    // Poll for results
    const maxAttempts = 60; // 5 minutes with 5 second intervals
    const pollInterval = 5000;
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const pollResponse = await axios.get(pollUrl, {
          headers: cortexRequest.headers
        });

        logger.info("Polling Replicate API - attempt " + attempt);
        const status = pollResponse.data?.status;
        
        if (status === "succeeded") {
          logger.info("Replicate API returned a completed response after polling");
          return JSON.stringify(pollResponse.data);
        } else if (status === "failed" || status === "canceled") {
          throw new Error(`Prediction ${status}: ${pollResponse.data?.error || "Unknown error"}`);
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      } catch (error) {
        logger.error(`Error polling prediction ${predictionId}: ${error.message}`);
        throw error;
      }
    }

    throw new Error(`Prediction ${predictionId} timed out after ${maxAttempts * pollInterval / 1000} seconds`);
  }

  // Stringify the response from the Replicate API
  parseResponse(data) {
    if (data.data) {
      return JSON.stringify(data.data);
    }
    return JSON.stringify(data);
  }

  // Override the logging function to display the request and response
  logRequestData(data, responseData, prompt) {
    const modelInput = data?.input?.prompt;

    logger.verbose(`${modelInput}`);
    logger.verbose(`${this.parseResponse(responseData)}`);

    prompt &&
      prompt.debugInfo &&
      (prompt.debugInfo += `\n${JSON.stringify(data)}`);
  }
}

export default ReplicateApiPlugin;
