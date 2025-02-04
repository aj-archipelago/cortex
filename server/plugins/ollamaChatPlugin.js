import ModelPlugin from './modelPlugin.js';

class OllamaChatPlugin extends ModelPlugin {
  constructor(pathway, model) {
    super(pathway, model);
    this.apiUrl = model.apiUrl || 'http://localhost:11434';
  }

  getRequestParameters(text, parameters, prompt) {
    const { modelPromptMessages } = this.getCompiledPrompt(text, parameters, prompt);
    return {
      data: {
        model: parameters.model,
        messages: modelPromptMessages
      },
      params: {}
    };
  }

  parseResponse(data) {
    // Split into lines and filter empty ones
    const lines = data.split('\n').filter(line => line.trim());
    
    let fullResponse = '';
    
    for (const line of lines) {
      try {
        const jsonObj = JSON.parse(line);
        
        if (jsonObj.message && jsonObj.message.content) {
          // Unescape special sequences
          const content = jsonObj.message.content
            .replace(/\\n/g, '\n')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\')
            .replace(/\\u003c/g, '<')
            .replace(/\\u003e/g, '>');
            
          fullResponse += content;
        }
      } catch (err) {
        console.error('Error parsing JSON line:', err);
      }
    }
  
    return fullResponse;
  }

  async execute(text, parameters, prompt, cortexRequest) {
    const requestParameters = this.getRequestParameters(text, parameters, prompt);
    cortexRequest.data = { ...(cortexRequest.data || {}), ...requestParameters.data };
    cortexRequest.params = { ...(cortexRequest.params || {}), ...requestParameters.params };
    return this.executeRequest(cortexRequest);
  }
}

export default OllamaChatPlugin;