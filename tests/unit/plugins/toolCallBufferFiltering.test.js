import test from 'ava';
import OpenAIVisionPlugin from '../../../server/plugins/openAiVisionPlugin.js';
import Gemini15VisionPlugin from '../../../server/plugins/gemini15VisionPlugin.js';
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
  const pluginToModelType = {
    OpenAIVisionPlugin: 'OPENAI-VISION',
    Gemini15VisionPlugin: 'GEMINI-1.5-VISION'
  };

  const modelType = pluginToModelType[pluginClass.name];
  if (!modelType) {
    throw new Error(`Unknown plugin class: ${pluginClass.name}`);
  }

  const pathway = {
    name: 'test-pathway',
    model: modelName,
    prompt: 'test prompt',
    toolCallback: () => {} // Mock tool callback
  };
  
  const model = {
    name: modelName,
    type: modelType
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

test('OpenAIVisionPlugin - filters undefined tool calls from buffer', async t => {
  const resolver = createResolverWithPlugin(OpenAIVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  // Simulate the scenario where tool calls start at index 1, leaving index 0 undefined
  plugin.toolCallsBuffer[0] = undefined; // This is what causes the issue
  plugin.toolCallsBuffer[1] = {
    id: 'call_1_1234567890',
    type: 'function',
    function: {
      name: 'test_tool',
      arguments: '{"param": "value"}'
    }
  };
  
  // Mock the tool callback to capture what gets passed
  let capturedToolCalls = null;
  plugin.pathwayToolCallback = (args, message, resolver) => {
    capturedToolCalls = message.tool_calls;
  };
  
  // Mock requestProgress and pathwayResolver
  const requestProgress = { progress: 0, started: true };
  const pathwayResolver = { args: {} };
  
  // Mock requestState to return our resolver
  requestState[plugin.requestId] = { pathwayResolver };
  
  // Simulate a tool_calls finish reason
  const event = {
    data: JSON.stringify({
      choices: [{
        finish_reason: 'tool_calls'
      }]
    })
  };
  
  // Process the stream event
  plugin.processStreamEvent(event, requestProgress);
  
  // Verify that undefined elements were filtered out
  t.truthy(capturedToolCalls, 'Tool callback should have been called');
  t.is(capturedToolCalls.length, 1, 'Should have filtered out undefined elements');
  t.is(capturedToolCalls[0].function.name, 'test_tool', 'Valid tool call should be preserved');
  
  // Clean up
  delete requestState[plugin.requestId];
});

test('OpenAIVisionPlugin - handles empty buffer gracefully', async t => {
  const resolver = createResolverWithPlugin(OpenAIVisionPlugin);
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
  const event = {
    data: JSON.stringify({
      choices: [{
        finish_reason: 'tool_calls'
      }]
    })
  };
  
  // Process the stream event
  plugin.processStreamEvent(event, requestProgress);
  
  // Verify that callback was not called with empty buffer
  t.falsy(callbackCalled, 'Tool callback should not be called with empty buffer');
  
  // Clean up
  delete requestState[plugin.requestId];
});

test('OpenAIVisionPlugin - filters invalid tool calls', async t => {
  const resolver = createResolverWithPlugin(OpenAIVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  // Create buffer with mixed valid and invalid tool calls
  plugin.toolCallsBuffer[0] = undefined;
  plugin.toolCallsBuffer[1] = {
    id: 'call_1_1234567890',
    type: 'function',
    function: {
      name: 'valid_tool',
      arguments: '{"param": "value"}'
    }
  };
  plugin.toolCallsBuffer[2] = {
    id: 'call_2_1234567890',
    type: 'function',
    function: {
      name: '', // Invalid: empty name
      arguments: '{"param": "value"}'
    }
  };
  plugin.toolCallsBuffer[3] = {
    id: 'call_3_1234567890',
    type: 'function',
    function: {
      name: 'another_valid_tool',
      arguments: '{"param": "value"}'
    }
  };
  
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
  const event = {
    data: JSON.stringify({
      choices: [{
        finish_reason: 'tool_calls'
      }]
    })
  };
  
  // Process the stream event
  plugin.processStreamEvent(event, requestProgress);
  
  // Verify that only valid tool calls were passed
  t.truthy(capturedToolCalls, 'Tool callback should have been called');
  t.is(capturedToolCalls.length, 2, 'Should have filtered out invalid elements');
  t.is(capturedToolCalls[0].function.name, 'valid_tool', 'First valid tool call should be preserved');
  t.is(capturedToolCalls[1].function.name, 'another_valid_tool', 'Second valid tool call should be preserved');
  
  // Clean up
  delete requestState[plugin.requestId];
});

test('Gemini15VisionPlugin - filters undefined tool calls from buffer', async t => {
  const resolver = createResolverWithPlugin(Gemini15VisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  // Simulate buffer with undefined elements (though less likely with push method)
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

test('Gemini15VisionPlugin - handles empty buffer gracefully', async t => {
  const resolver = createResolverWithPlugin(Gemini15VisionPlugin);
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
