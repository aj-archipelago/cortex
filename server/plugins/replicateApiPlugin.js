// replicateApiPlugin.js
import ModelPlugin from "./modelPlugin.js";
import logger from "../../lib/logger.js";

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

    const requestParameters = {
      input: {
        aspect_ratio: "1:1",
        output_format: "webp",
        output_quality: 80,
        prompt: modelPromptText,
        //prompt_upsampling: false,
        //safety_tolerance: 5,
        go_fast: true,
        megapixels: "1",
        num_outputs: combinedParameters.numberResults,
      },
    };

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

    return this.executeRequest(cortexRequest);
  }

  // Parse the response from the Replicate API
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
