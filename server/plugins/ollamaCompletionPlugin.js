import ModelPlugin from './modelPlugin.js';

class OllamaCompletionPlugin extends ModelPlugin {
  constructor(pathway, model) {
    super(pathway, model);
    this.apiUrl = model.apiUrl || 'http://localhost:11434';
  }

  getRequestParameters(text, parameters, prompt) {
    const {stream=false, model} = parameters;
    let { modelPromptText } = this.getCompiledPrompt(text, parameters, prompt);

    return {
      data: {
        model,
        "prompt": modelPromptText,
        stream
      },
      params:{
      }
    };
  }

  parseResponse(data) { 
    return data?.response || JSON.stringify(data) || ''; 
  }

  async execute(text, parameters, prompt, cortexRequest) {
    const requestParameters = this.getRequestParameters(text, parameters, prompt);
    cortexRequest.data = { ...(cortexRequest.data || {}), ...requestParameters.data };
    cortexRequest.params = {...(cortexRequest.params || {}), ...requestParameters.params};
    return this.executeRequest(cortexRequest);
  }
}

export default OllamaCompletionPlugin;