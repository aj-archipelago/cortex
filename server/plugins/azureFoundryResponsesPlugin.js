// azureFoundryResponsesPlugin.js
// Azure Foundry hosted-agent endpoint using the OpenAI Responses protocol.

import OpenAIResponsesPlugin from "./openAiResponsesPlugin.js";
import logger from "../../lib/logger.js";

class AzureFoundryResponsesPlugin extends OpenAIResponsesPlugin {
  removeAgentManagedBodyParams(cortexRequest) {
    if (!cortexRequest?.data || typeof cortexRequest.data !== "object") {
      return;
    }

    // Hosted-agent Responses endpoints own model/tool/reasoning configuration
    // server-side and reject these generic Responses fields when an agent is
    // embedded in the endpoint URL.
    delete cortexRequest.data.model;
    delete cortexRequest.data.reasoning;
    delete cortexRequest.data.tools;
    delete cortexRequest.data.tool_choice;
    delete cortexRequest.data.parallel_tool_calls;
  }

  async getRequestParameters(text, parameters, prompt) {
    const requestParameters = await super.getRequestParameters(
      text,
      parameters,
      prompt,
    );

    delete requestParameters.model;
    delete requestParameters.reasoning;
    delete requestParameters.tools;
    delete requestParameters.tool_choice;
    delete requestParameters.parallel_tool_calls;

    return requestParameters;
  }

  async executeRequest(cortexRequest) {
    this.removeAgentManagedBodyParams(cortexRequest);
    return super.executeRequest(cortexRequest);
  }

  removeEndpointQueryParamsFromBody(cortexRequest) {
    if (!cortexRequest?.data || typeof cortexRequest.data !== "object") {
      return;
    }

    for (const key of Object.keys(cortexRequest.selectedEndpoint?.params || {})) {
      delete cortexRequest.data[key];
    }
  }

  async addAzureAuthorization(cortexRequest) {
    const azureAuthTokenHelper = this.config.get("azureAuthTokenHelper");
    if (!azureAuthTokenHelper) {
      throw new Error("azureAuthTokenHelper is not configured");
    }

    try {
      const authToken = await azureAuthTokenHelper.getAccessToken();
      cortexRequest.addHeaders = {
        Authorization: `Bearer ${authToken}`,
      };
    } catch (error) {
      logger.warn(
        `[Azure Foundry Responses] Failed to get auth token: ${error.message}`,
      );
      throw error;
    }
  }

  async execute(text, parameters, prompt, cortexRequest) {
    await this.addAzureAuthorization(cortexRequest);
    this.removeEndpointQueryParamsFromBody(cortexRequest);
    return super.execute(text, parameters, prompt, cortexRequest);
  }

  parseResponse(data) {
    const parsed = super.parseResponse(data);
    const value =
      typeof parsed === "string"
        ? parsed
        : parsed?.output_text !== undefined
          ? parsed.output_text
          : parsed?.toString
            ? parsed.toString()
            : "";

    return JSON.stringify({ value });
  }
}

export default AzureFoundryResponsesPlugin;
