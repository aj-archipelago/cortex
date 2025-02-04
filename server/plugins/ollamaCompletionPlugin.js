import ModelPlugin from './modelPlugin.js';
import logger from '../../lib/logger.js';
import { Transform } from 'stream';

class OllamaCompletionPlugin extends ModelPlugin {

  getRequestParameters(text, parameters, prompt) {
    return {
      data: {
        model: parameters.model,
        prompt: text,
        stream: parameters.stream
      },
      params: {}
    };
  }

  logRequestData(data, responseData, prompt) {
    const { stream, prompt: promptText, model } = data;

    if (promptText) {
      logger.info(`[ollama completion request sent to model ${model}]`);
      const { length, units } = this.getLength(promptText);
      const preview = this.shortenContent(promptText);
      logger.verbose(`prompt ${units}: ${length}, content: "${preview}"`);
      logger.info(`[completion request contained ${length} ${units}]`);
    }

    if (stream) {
      logger.info(`[response received as an SSE stream]`);
    } else if (responseData) {
      const responseText = this.parseResponse(responseData);
      const { length, units } = this.getLength(responseText);
      logger.info(`[response received containing ${length} ${units}]`);
      logger.verbose(`${this.shortenContent(responseText)}`);
    }

    prompt &&
      prompt.debugInfo &&
      (prompt.debugInfo += `\n${JSON.stringify(data)}`);
  }

  parseResponse(data) {
    // If data is not a string (e.g. streaming), return as is
    if (typeof data !== 'string') {
      return data;
    }

    // Split into lines and filter empty ones
    const lines = data.split('\n').filter(line => line.trim());
    
    let fullResponse = '';
    
    for (const line of lines) {
      try {
        const jsonObj = JSON.parse(line);
        
        if (jsonObj.response) {
          // Unescape special sequences
          const content = jsonObj.response
            .replace(/\\n/g, '\n')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\')
            .replace(/\\u003c/g, '<')
            .replace(/\\u003e/g, '>');
            
          fullResponse += content;
        }
      } catch (err) {
        // If we can't parse the line as JSON, just skip it
        continue;
      }
    }
  
    return fullResponse;
  }

  processStreamEvent(event, requestProgress) {
    try {
      const data = JSON.parse(event.data);
      
      // Handle the streaming response
      if (data.response) {
        // Unescape special sequences in the content
        const content = data.response
          .replace(/\\n/g, '\n')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
          .replace(/\\u003c/g, '<')
          .replace(/\\u003e/g, '>');
          
        requestProgress.data = JSON.stringify(content);
      }

      // Check if this is the final message
      if (data.done) {
        requestProgress.data = '[DONE]';
        requestProgress.progress = 1;
      }

      return requestProgress;
    } catch (err) {
      // If we can't parse the event data, return the progress as is
      return requestProgress;
    }
  }

  async execute(text, parameters, prompt, cortexRequest) {
    const requestParameters = this.getRequestParameters(text, parameters, prompt);
    cortexRequest.data = { ...(cortexRequest.data || {}), ...requestParameters.data };
    cortexRequest.params = { ...(cortexRequest.params || {}), ...requestParameters.params };
    
    // For Ollama streaming, transform NDJSON to SSE format
    if (parameters.stream) {
      const response = await this.executeRequest(cortexRequest);
      
      // Create a transform stream that converts NDJSON to SSE format
      const transformer = new Transform({
        decodeStrings: false, // Keep as string
        transform(chunk, encoding, callback) {
          try {
            const lines = chunk.toString().split('\n');
            for (const line of lines) {
              if (line.trim()) {
                // Format as SSE data
                this.push(`data: ${line}\n\n`);
              }
            }
            callback();
          } catch (err) {
            callback(err);
          }
        }
      });

      // Pipe the response through our transformer
      response.pipe(transformer);
      
      // Return the transformed stream
      return transformer;
    }
    
    return this.executeRequest(cortexRequest);
  }
}

export default OllamaCompletionPlugin;