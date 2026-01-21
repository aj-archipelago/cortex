import Claude4VertexPlugin from "./claude4VertexPlugin.js";

/**
 * Plugin for direct Anthropic API access (api.anthropic.com)
 * 
 * This plugin extends Claude4VertexPlugin and reuses all the message/content
 * conversion logic, but uses direct Anthropic API authentication and endpoints
 * instead of Google Vertex AI.
 * 
 * Key differences from Vertex AI:
 * - Uses x-api-key header instead of Bearer token
 * - Uses https://api.anthropic.com/v1/messages endpoint
 * - Model specified in request body, not URL
 * - anthropic-version specified in header, not body
 * - Streaming via stream:true in body, not URL suffix
 */
class ClaudeAnthropicPlugin extends Claude4VertexPlugin {
  
  constructor(pathway, model) {
    super(pathway, model);
  }
  
  async getRequestParameters(text, parameters, prompt) {
    // Get base request parameters from parent (includes message conversion)
    const requestParameters = await super.getRequestParameters(
      text,
      parameters,
      prompt
    );

    // Remove Vertex-specific anthropic_version from body
    delete requestParameters.anthropic_version;
    
    // Add model to request body (required for direct Anthropic API)
    // The model name should come from the endpoint params or model config
    const modelName = this.model.params?.model || 
                      this.model.endpoints?.[0]?.params?.model ||
                      this.modelName;
    requestParameters.model = modelName;
    
    return requestParameters;
  }

  async execute(text, parameters, prompt, cortexRequest) {
    const requestParameters = await this.getRequestParameters(
      text,
      parameters,
      prompt,
      cortexRequest
    );
    const { stream } = parameters;

    // Add stream parameter to request body for Anthropic API
    if (stream) {
      requestParameters.stream = true;
    }

    cortexRequest.data = {
      ...(cortexRequest.data || {}),
      ...requestParameters,
    };
    cortexRequest.params = {}; // query params
    cortexRequest.stream = stream;
    
    // Direct Anthropic API doesn't use URL suffix for streaming
    cortexRequest.urlSuffix = "";

    // Set Anthropic-specific headers
    // The x-api-key should already be in the model config headers
    // but we need to add the anthropic-version header
    cortexRequest.headers = {
      ...(cortexRequest.headers || {}),
      "anthropic-version": "2023-06-01"
    };

    // For direct Anthropic API, authentication is handled via headers in config
    // (x-api-key: {{CLAUDE_API_KEY}})
    // No need for GCP auth token

    return this.executeRequest(cortexRequest);
  }
}

export default ClaudeAnthropicPlugin;
