import ModelPlugin from './modelPlugin.js';
import logger from '../../lib/logger.js';
import { Transform } from 'stream';

class OllamaChatPlugin extends ModelPlugin {

  getRequestParameters(text, parameters, prompt) {
    const { modelPromptMessages } = this.getCompiledPrompt(text, parameters, prompt);
    return {
      data: {
        model: parameters.model,
        messages: modelPromptMessages,
        stream: parameters.stream
      },
      params: {}
    };
  }

  logRequestData(data, responseData, prompt) {
    const { stream, messages, model } = data;

    if (messages && messages.length > 0) {
      logger.info(`[ollama chat request sent to model ${model} containing ${messages.length} messages]`);
      let totalLength = 0;
      let totalUnits;
      messages.forEach((message, index) => {
        const content = message.content;
        const { length, units } = this.getLength(content);
        const preview = this.shortenContent(content);

        logger.verbose(
          `message ${index + 1}: role: ${message.role}, ${units}: ${length}, content: "${preview}"`
        );
        totalLength += length;
        totalUnits = units;
      });
      logger.info(`[chat request contained ${totalLength} ${totalUnits}]`);
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
      if (data.message?.content) {
        // Unescape special sequences in the content
        const content = data.message.content
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

export default OllamaChatPlugin;