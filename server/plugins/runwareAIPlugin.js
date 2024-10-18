// RunwareAiPlugin.js
import ModelPlugin from "./modelPlugin.js";
import logger from "../../lib/logger.js";
import { config } from "../../config.js";
import { v4 as uuidv4 } from "uuid";

class RunwareAiPlugin extends ModelPlugin {
  constructor(pathway, model) {
    super(pathway, model);
  }

  // Set up parameters specific to the Runware REST API
  getRequestParameters(text, parameters, prompt) {
    const combinedParameters = { ...this.promptParameters, ...parameters };
    const { modelPromptText } = this.getCompiledPrompt(
      text,
      parameters,
      prompt,
    );

    const requestParameters = {
      data: [
        {
          taskType: "authentication",
          apiKey: config.get("runwareAiApiKey"),
        },
        {
          taskType: "imageInference",
          taskUUID: uuidv4(),
          positivePrompt: modelPromptText,
          width: combinedParameters.width,
          height: combinedParameters.height,
          modelId: "runware:100@1",
          CFGScale: 4.0,
          negative_prompt: combinedParameters.negativePrompt,
          numberResults: combinedParameters.numberResults,
          steps: combinedParameters.steps,
          checkNSFW: false,
        },
      ],
    };

    return requestParameters;
  }

  // Execute the request to the Runware REST API
  async execute(text, parameters, prompt, cortexRequest) {
    const requestParameters = this.getRequestParameters(
      text,
      parameters,
      prompt,
    );

    cortexRequest.data = requestParameters.data;
    cortexRequest.params = requestParameters.params;

    return this.executeRequest(cortexRequest);
  }

  // Parse the response from the Azure Translate API
  parseResponse(data) {
    if (data.data) {
      return JSON.stringify(data.data);
    }
    return JSON.stringify(data);
  }

  // Override the logging function to display the request and response
  logRequestData(data, responseData, prompt) {
    const modelInput = data[1].positivePrompt;

    logger.verbose(`${modelInput}`);
    logger.verbose(`${this.parseResponse(responseData)}`);

    prompt &&
      prompt.debugInfo &&
      (prompt.debugInfo += `\n${JSON.stringify(data)}`);
  }
}

export default RunwareAiPlugin;
