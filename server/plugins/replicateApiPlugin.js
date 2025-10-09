// replicateApiPlugin.js
import ModelPlugin from "./modelPlugin.js";
import CortexResponse from "../../lib/cortexResponse.js";
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
            ...(combinedParameters.seed && Number.isInteger(combinedParameters.seed) ? { seed: combinedParameters.seed } : {}),
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
      case "replicate-qwen-image": {
        const aspectRatio = combinedParameters.aspect_ratio ?? combinedParameters.aspectRatio ?? "16:9";
        const imageSize = combinedParameters.image_size ?? combinedParameters.imageSize ?? "optimize_for_quality";
        const outputFormat = combinedParameters.output_format ?? combinedParameters.outputFormat ?? "webp";
        const outputQuality = combinedParameters.output_quality ?? combinedParameters.outputQuality ?? 80;
        const loraScale = combinedParameters.lora_scale ?? combinedParameters.loraScale ?? 1;
        const enhancePrompt = combinedParameters.enhance_prompt ?? combinedParameters.enhancePrompt ?? false;
        const negativePrompt = combinedParameters.negative_prompt ?? combinedParameters.negativePrompt ?? " ";
        const numInferenceSteps = combinedParameters.num_inference_steps ?? combinedParameters.steps ?? 50;
        const goFast = combinedParameters.go_fast ?? combinedParameters.goFast ?? true;
        const guidance = combinedParameters.guidance ?? 4;
        const strength = combinedParameters.strength ?? 0.9;
        const numOutputs = combinedParameters.num_outputs ?? combinedParameters.numberResults;
        const disableSafetyChecker = combinedParameters.disable_safety_checker ?? combinedParameters.disableSafetyChecker ?? false;

        requestParameters = {
          input: {
            prompt: modelPromptText,
            go_fast: goFast,
            guidance,
            strength,
            image_size: imageSize,
            lora_scale: loraScale,
            aspect_ratio: aspectRatio,
            output_format: outputFormat,
            enhance_prompt: enhancePrompt,
            output_quality: outputQuality,
            negative_prompt: negativePrompt,
            num_inference_steps: numInferenceSteps,
            disable_safety_checker: disableSafetyChecker,
            ...(numOutputs ? { num_outputs: numOutputs } : {}),
            ...(combinedParameters.seed && Number.isInteger(combinedParameters.seed) ? { seed: combinedParameters.seed } : {}),
            ...(combinedParameters.image ? { image: combinedParameters.image } : {}),
            ...(combinedParameters.input_image ? { input_image: combinedParameters.input_image } : {}),
          },
        };
        break;
      }
      case "replicate-qwen-image-edit-plus": {
        const aspectRatio = combinedParameters.aspect_ratio ?? combinedParameters.aspectRatio ?? "match_input_image";
        const outputFormat = combinedParameters.output_format ?? combinedParameters.outputFormat ?? "webp";
        const outputQuality = combinedParameters.output_quality ?? combinedParameters.outputQuality ?? 95;
        const goFast = combinedParameters.go_fast ?? combinedParameters.goFast ?? true;
        const disableSafetyChecker = combinedParameters.disable_safety_checker ?? combinedParameters.disableSafetyChecker ?? false;

        const collectImages = (candidate, accumulator) => {
          if (!candidate) return;
          if (Array.isArray(candidate)) {
            candidate.forEach((item) => collectImages(item, accumulator));
            return;
          }
          accumulator.push(candidate);
        };

        const imageCandidates = [];
        collectImages(combinedParameters.image, imageCandidates);
        collectImages(combinedParameters.images, imageCandidates);
        collectImages(combinedParameters.input_image, imageCandidates);
        collectImages(combinedParameters.input_images, imageCandidates);
        collectImages(combinedParameters.input_image_1, imageCandidates);
        collectImages(combinedParameters.input_image_2, imageCandidates);
        collectImages(combinedParameters.input_image_3, imageCandidates);
        collectImages(combinedParameters.image_1, imageCandidates);
        collectImages(combinedParameters.image_2, imageCandidates);

        const normalizeImageEntry = (entry) => {
          if (!entry) return null;
          if (typeof entry === "string") {
            return entry; // Return the URL string directly
          }
          if (typeof entry === "object") {
            if (Array.isArray(entry)) {
              return null;
            }
            if (entry.value) {
              return entry.value; // Return the value as a string
            }
            if (entry.url) {
              return entry.url; // Return the URL as a string
            }
            if (entry.path) {
              return entry.path; // Return the path as a string
            }
          }
          return null;
        };

        const normalizedImages = imageCandidates
          .map((candidate) => normalizeImageEntry(candidate))
          .filter((candidate) => candidate && typeof candidate === 'string');

        const omitUndefined = (obj) =>
          Object.fromEntries(
            Object.entries(obj).filter(([, value]) => value !== undefined && value !== null),
          );

        const basePayload = omitUndefined({
          prompt: modelPromptText,
          go_fast: goFast,
          aspect_ratio: aspectRatio,
          output_format: outputFormat,
          output_quality: outputQuality,
          disable_safety_checker: disableSafetyChecker,
        });

        // For qwen-image-edit-plus, always include the image array if we have images
        const inputPayload = {
          ...basePayload,
          ...(normalizedImages.length > 0 ? { image: normalizedImages } : {})
        };

        requestParameters = {
          input: inputPayload,
        };
        break;
      }
      case "replicate-flux-kontext-pro":
      case "replicate-flux-kontext-max": {
        const validRatios = [
          '1:1', '16:9', '21:9', '3:2', '2:3', '4:5',
          '5:4', '3:4', '4:3', '9:16', '9:21', 'match_input_image'
        ];

        let safetyTolerance = combinedParameters.safety_tolerance || 3;
        if(combinedParameters.input_image){
          safetyTolerance = Math.min(safetyTolerance, 2);
        }

        requestParameters = {
          input: {
            prompt: modelPromptText,
            input_image: combinedParameters.input_image,
            aspect_ratio: validRatios.includes(combinedParameters.aspectRatio) ? combinedParameters.aspectRatio : "1:1",
            safety_tolerance: safetyTolerance,
            ...(combinedParameters.seed && Number.isInteger(combinedParameters.seed) && combinedParameters.seed > 0 ? { seed: combinedParameters.seed } : {}),
          },
        };
        break;
      }
      case "replicate-multi-image-kontext-max": {
        const validRatios = [
          '1:1', '16:9', '21:9', '3:2', '2:3', '4:5',
          '5:4', '3:4', '4:3', '9:16', '9:21', 'match_input_image'
        ];

        let safetyTolerance = combinedParameters.safety_tolerance || 3;
        if(combinedParameters.input_image_1 || combinedParameters.input_image) {
          safetyTolerance = Math.min(safetyTolerance, 2);
        }

        requestParameters = {
          input: {
            prompt: modelPromptText,
            input_image_1: combinedParameters.input_image_1 || combinedParameters.input_image,
            input_image_2: combinedParameters.input_image_2,
            aspect_ratio: validRatios.includes(combinedParameters.aspectRatio) ? combinedParameters.aspectRatio : "1:1",
            safety_tolerance: safetyTolerance,
            ...(combinedParameters.seed && Number.isInteger(combinedParameters.seed) && combinedParameters.seed > 0 ? { seed: combinedParameters.seed } : {}),
          },
        };
        break;
      }
      case "replicate-seedance-1-pro": {
        const validResolutions = ["480p", "1080p"];
        const validRatios = ["16:9", "4:3", "9:16", "1:1", "3:4", "21:9", "9:21"];
        const validFps = [24];

        requestParameters = {
          input: {
            prompt: modelPromptText,
            resolution: validResolutions.includes(combinedParameters.resolution) ? combinedParameters.resolution : "1080p",
            aspect_ratio: validRatios.includes(combinedParameters.aspectRatio) ? combinedParameters.aspectRatio : "16:9",
            ...(combinedParameters.seed && Number.isInteger(combinedParameters.seed) && combinedParameters.seed > 0 ? { seed: combinedParameters.seed } : {}),
            fps: validFps.includes(combinedParameters.fps) ? combinedParameters.fps : 24,
            camera_fixed: combinedParameters.camera_fixed || false,
            duration: combinedParameters.duration || 5,
            ...(combinedParameters.image ? { image: combinedParameters.image } : {}),
          },
        };
        break;
      }
      case "replicate-seedream-4": {
        const validSizes = ["1K", "2K", "4K", "custom"];
        const validRatios = ["1:1", "4:3", "3:4", "16:9", "9:16", "match_input_image"];
        const validSequentialModes = ["disabled", "auto"];

        // Collect input images from multiple parameter sources (same pattern as qwen-image-edit-plus)
        const collectImages = (candidate, accumulator) => {
          if (!candidate) return;
          if (Array.isArray(candidate)) {
            candidate.forEach((item) => collectImages(item, accumulator));
            return;
          }
          accumulator.push(candidate);
        };

        const imageCandidates = [];
        collectImages(combinedParameters.image, imageCandidates);
        collectImages(combinedParameters.images, imageCandidates);
        collectImages(combinedParameters.input_image, imageCandidates);
        collectImages(combinedParameters.input_images, imageCandidates);
        collectImages(combinedParameters.input_image_1, imageCandidates);
        collectImages(combinedParameters.input_image_2, imageCandidates);
        collectImages(combinedParameters.input_image_3, imageCandidates);
        collectImages(combinedParameters.image_1, imageCandidates);
        collectImages(combinedParameters.image_2, imageCandidates);
        collectImages(combinedParameters.imageInput, imageCandidates);

        const normalizeImageEntry = (entry) => {
          if (!entry) return null;
          if (typeof entry === "string") {
            return entry; // Return the URL string directly
          }
          if (typeof entry === "object") {
            if (Array.isArray(entry)) {
              return null;
            }
            if (entry.value) {
              return entry.value; // Return the value as a string
            }
            if (entry.url) {
              return entry.url; // Return the URL as a string
            }
            if (entry.path) {
              return entry.path; // Return the path as a string
            }
          }
          return null;
        };

        const normalizedImages = imageCandidates
          .map((candidate) => normalizeImageEntry(candidate))
          .filter((candidate) => candidate && typeof candidate === 'string');

        const omitUndefined = (obj) =>
          Object.fromEntries(
            Object.entries(obj).filter(([, value]) => value !== undefined && value !== null),
          );

        const basePayload = omitUndefined({
          prompt: modelPromptText,
          size: validSizes.includes(combinedParameters.size) ? combinedParameters.size : "2K",
          width: combinedParameters.width || 2048,
          height: combinedParameters.height || 2048,
          max_images: combinedParameters.maxImages || combinedParameters.numberResults || 1,
          aspect_ratio: validRatios.includes(combinedParameters.aspectRatio) ? combinedParameters.aspectRatio : "4:3",
          sequential_image_generation: validSequentialModes.includes(combinedParameters.sequentialImageGeneration) ? combinedParameters.sequentialImageGeneration : "disabled",
          ...(combinedParameters.seed && Number.isInteger(combinedParameters.seed) && combinedParameters.seed > 0 ? { seed: combinedParameters.seed } : {}),
        });

        // For seedream-4, include the image_input array if we have images
        const inputPayload = {
          ...basePayload,
          ...(normalizedImages.length > 0 ? { image_input: normalizedImages } : {})
        };

        requestParameters = {
          input: inputPayload,
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
    const response = await this.executeRequest(cortexRequest);
    
    // Parse the response to get the actual Replicate data
    const parsedResponse = JSON.parse(response.output_text);

    // If we got a completed response, return it as CortexResponse
    if (parsedResponse?.status === "succeeded") {
      return this.createCortexResponse(response);
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
          // Parse the polled response to extract artifacts
          const parsedResponse = this.parseResponse(pollResponse.data);
          return this.createCortexResponse(parsedResponse);
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

  // Parse the response from the Replicate API and extract image artifacts
  parseResponse(data) {
    const responseData = data.data || data;
    const stringifiedResponse = JSON.stringify(responseData);
    
    // Extract image URLs from Replicate response for artifacts
    const imageArtifacts = [];
    if (responseData?.output && Array.isArray(responseData.output)) {
      for (const outputItem of responseData.output) {
        if (typeof outputItem === 'string' && outputItem.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
          // This is an image URL from Replicate
          imageArtifacts.push({
            type: "image",
            url: outputItem,
            mimeType: this.getMimeTypeFromUrl(outputItem)
          });
        }
      }
    }
    
    return {
      output_text: stringifiedResponse,
      artifacts: imageArtifacts
    };
  }

  // Create a CortexResponse from parsed response data
  createCortexResponse(parsedResponse) {
    if (typeof parsedResponse === 'string') {
      // Handle string response (backward compatibility)
      return new CortexResponse({
        output_text: parsedResponse,
        artifacts: []
      });
    } else if (parsedResponse && typeof parsedResponse === 'object') {
      // Handle object response with artifacts
      return new CortexResponse({
        output_text: parsedResponse.output_text,
        artifacts: parsedResponse.artifacts || []
      });
    } else {
      throw new Error('Unexpected response format');
    }
  }

  // Helper method to determine MIME type from URL extension
  getMimeTypeFromUrl(url) {
    const extension = url.split('.').pop().toLowerCase();
    switch (extension) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'gif':
        return 'image/gif';
      case 'webp':
        return 'image/webp';
      default:
        return 'image/jpeg'; // Default fallback
    }
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
