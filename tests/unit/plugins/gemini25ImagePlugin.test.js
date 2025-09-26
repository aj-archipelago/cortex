import test from 'ava';
import Gemini25ImagePlugin from '../../../server/plugins/gemini25ImagePlugin.js';
import { PathwayResolver } from '../../../server/pathwayResolver.js';
import { config } from '../../../config.js';
import { requestState } from '../../../server/requestState.js';

// Mock logger to prevent issues in tests
const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
};

// Mock the logger module globally
global.logger = mockLogger;

function createResolverWithPlugin(pluginClass, modelName = 'test-model') {
  const pathway = {
    name: 'test-pathway',
    model: modelName,
    prompt: 'test prompt',
    toolCallback: () => {} // Mock tool callback
  };
  
  const model = {
    name: modelName,
    type: 'GEMINI-2.5-IMAGE'
  };
  
  const resolver = new PathwayResolver({ 
    config,
    pathway,
    args: {},
    endpoints: { [modelName]: model }
  });
  
  resolver.modelExecutor.plugin = new pluginClass(pathway, model);
  return resolver;
}

test('Gemini25ImagePlugin - filters undefined tool calls from buffer', async t => {
  const resolver = createResolverWithPlugin(Gemini25ImagePlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  // Simulate buffer with undefined elements
  plugin.toolCallsBuffer = [
    undefined,
    {
      id: 'call_1_1234567890',
      type: 'function',
      function: {
        name: 'test_tool',
        arguments: '{"param": "value"}'
      }
    }
  ];
  
  // Mock the tool callback
  let capturedToolCalls = null;
  plugin.pathwayToolCallback = (args, message, resolver) => {
    capturedToolCalls = message.tool_calls;
  };
  
  // Mock requestProgress and pathwayResolver
  const requestProgress = { progress: 0, started: true };
  const pathwayResolver = { args: {} };
  
  // Mock requestState
  requestState[plugin.requestId] = { pathwayResolver };
  
  // Simulate a tool_calls finish reason
  const eventData = {
    candidates: [{
      finishReason: 'STOP'
    }]
  };
  
  // Set hadToolCalls to true to trigger tool_calls finish reason
  plugin.hadToolCalls = true;
  
  // Process the stream event
  plugin.processStreamEvent({ data: JSON.stringify(eventData) }, requestProgress);
  
  // Verify that undefined elements were filtered out
  t.truthy(capturedToolCalls, 'Tool callback should have been called');
  t.is(capturedToolCalls.length, 1, 'Should have filtered out undefined elements');
  t.is(capturedToolCalls[0].function.name, 'test_tool', 'Valid tool call should be preserved');
  
  // Clean up
  delete requestState[plugin.requestId];
});

test('Gemini25ImagePlugin - handles empty buffer gracefully', async t => {
  const resolver = createResolverWithPlugin(Gemini25ImagePlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  // Empty buffer
  plugin.toolCallsBuffer = [];
  
  // Mock the tool callback
  let callbackCalled = false;
  plugin.pathwayToolCallback = () => {
    callbackCalled = true;
  };
  
  // Mock requestProgress and pathwayResolver
  const requestProgress = { progress: 0, started: true };
  const pathwayResolver = { args: {} };
  
  // Mock requestState
  requestState[plugin.requestId] = { pathwayResolver };
  
  // Simulate a tool_calls finish reason
  const eventData = {
    candidates: [{
      finishReason: 'STOP'
    }]
  };
  
  // Set hadToolCalls to true
  plugin.hadToolCalls = true;
  
  // Process the stream event
  plugin.processStreamEvent({ data: JSON.stringify(eventData) }, requestProgress);
  
  // Verify that callback was not called with empty buffer
  t.falsy(callbackCalled, 'Tool callback should not be called with empty buffer');
  
  // Clean up
  delete requestState[plugin.requestId];
});

test('Gemini25ImagePlugin - handles image artifacts in streaming', async t => {
  const resolver = createResolverWithPlugin(Gemini25ImagePlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  // Mock requestProgress
  const requestProgress = { progress: 0, started: true };
  
  // Simulate event with image artifact
  const eventData = {
    candidates: [{
      content: {
        parts: [{
          inlineData: {
            data: 'base64imagedata',
            mimeType: 'image/png'
          }
        }]
      }
    }]
  };
  
  // Process the stream event
  plugin.processStreamEvent({ data: JSON.stringify(eventData) }, requestProgress);
  
  // Verify that image artifacts were captured
  t.truthy(requestProgress.artifacts, 'Artifacts should be created');
  t.is(requestProgress.artifacts.length, 1, 'Should have one image artifact');
  t.is(requestProgress.artifacts[0].type, 'image', 'Artifact should be of type image');
  t.is(requestProgress.artifacts[0].data, 'base64imagedata', 'Image data should be preserved');
  t.is(requestProgress.artifacts[0].mimeType, 'image/png', 'MIME type should be preserved');
});

test('Gemini25ImagePlugin - handles multiple image artifacts', async t => {
  const resolver = createResolverWithPlugin(Gemini25ImagePlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  // Mock requestProgress
  const requestProgress = { progress: 0, started: true };
  
  // Simulate event with multiple image artifacts
  const eventData = {
    candidates: [{
      content: {
        parts: [
          {
            inlineData: {
              data: 'base64image1',
              mimeType: 'image/png'
            }
          },
          {
            inlineData: {
              data: 'base64image2',
              mimeType: 'image/jpeg'
            }
          }
        ]
      }
    }]
  };
  
  // Process the stream event
  plugin.processStreamEvent({ data: JSON.stringify(eventData) }, requestProgress);
  
  // Verify that multiple image artifacts were captured
  t.truthy(requestProgress.artifacts, 'Artifacts should be created');
  t.is(requestProgress.artifacts.length, 2, 'Should have two image artifacts');
  t.is(requestProgress.artifacts[0].type, 'image', 'First artifact should be of type image');
  t.is(requestProgress.artifacts[0].data, 'base64image1', 'First image data should be preserved');
  t.is(requestProgress.artifacts[0].mimeType, 'image/png', 'First MIME type should be preserved');
  t.is(requestProgress.artifacts[1].type, 'image', 'Second artifact should be of type image');
  t.is(requestProgress.artifacts[1].data, 'base64image2', 'Second image data should be preserved');
  t.is(requestProgress.artifacts[1].mimeType, 'image/jpeg', 'Second MIME type should be preserved');
});

test('Gemini25ImagePlugin - handles mixed content with text and images', async t => {
  const resolver = createResolverWithPlugin(Gemini25ImagePlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  // Mock requestProgress
  const requestProgress = { progress: 0, started: true };
  
  // Simulate event with mixed content (text + image)
  const eventData = {
    candidates: [{
      content: {
        parts: [
          {
            text: 'Here is an image:'
          },
          {
            inlineData: {
              data: 'base64imagedata',
              mimeType: 'image/png'
            }
          }
        ]
      }
    }]
  };
  
  // Process the stream event
  plugin.processStreamEvent({ data: JSON.stringify(eventData) }, requestProgress);
  
  // Verify that both text content and image artifacts were handled
  t.truthy(requestProgress.artifacts, 'Artifacts should be created');
  t.is(requestProgress.artifacts.length, 1, 'Should have one image artifact');
  t.is(requestProgress.artifacts[0].type, 'image', 'Artifact should be of type image');
  t.is(requestProgress.artifacts[0].data, 'base64imagedata', 'Image data should be preserved');
  
  // Clean up
  delete requestState[plugin.requestId];
});

test('Gemini25ImagePlugin - handles response_modalities parameter', async t => {
  const resolver = createResolverWithPlugin(Gemini25ImagePlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  // Test with response_modalities parameter
  const parameters = {
    response_modalities: '["TEXT", "IMAGE"]'
  };
  
  const prompt = {
    prompt: 'test prompt'
  };
  
  const cortexRequest = {
    pathway: {}
  };
  
  const requestParams = plugin.getRequestParameters('test text', parameters, prompt, cortexRequest);
  
  // Verify that response_modalities was added to generationConfig
  t.truthy(requestParams.generationConfig.response_modalities, 'response_modalities should be set');
  t.deepEqual(requestParams.generationConfig.response_modalities, ['TEXT', 'IMAGE'], 'response_modalities should be parsed correctly');
});

test('Gemini25ImagePlugin - handles response_modalities from pathway', async t => {
  const resolver = createResolverWithPlugin(Gemini25ImagePlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  // Test with response_modalities from pathway
  const parameters = {};
  
  const prompt = {
    prompt: 'test prompt'
  };
  
  const cortexRequest = {
    pathway: {
      response_modalities: ['TEXT', 'IMAGE']
    }
  };
  
  const requestParams = plugin.getRequestParameters('test text', parameters, prompt, cortexRequest);
  
  // Verify that response_modalities was added to generationConfig
  t.truthy(requestParams.generationConfig.response_modalities, 'response_modalities should be set');
  t.deepEqual(requestParams.generationConfig.response_modalities, ['TEXT', 'IMAGE'], 'response_modalities should be set correctly');
});
