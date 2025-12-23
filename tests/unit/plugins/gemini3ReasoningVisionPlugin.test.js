import test from 'ava';
import Gemini3ReasoningVisionPlugin from '../../../server/plugins/gemini3ReasoningVisionPlugin.js';
import { PathwayResolver } from '../../../server/pathwayResolver.js';
import { config } from '../../../config.js';

// Mock logger to prevent issues in tests
const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
};

global.logger = mockLogger;

function createResolverWithPlugin(pluginClass, modelName = 'test-model') {
  const pathway = {
    name: 'test-pathway',
    model: modelName,
    prompt: 'test prompt',
    toolCallback: () => {}
  };
  
  const model = {
    name: modelName,
    type: 'GEMINI-3-REASONING-VISION'
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

// ===== buildFunctionCallPart tests =====

test('buildFunctionCallPart - includes thoughtSignature when present', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  const toolCall = {
    function: { name: 'SearchInternet' },
    thoughtSignature: 'abc123signature'
  };
  const args = { query: 'test query' };
  
  const result = plugin.buildFunctionCallPart(toolCall, args);
  
  t.is(result.functionCall.name, 'SearchInternet');
  t.deepEqual(result.functionCall.args, { query: 'test query' });
  t.is(result.thoughtSignature, 'abc123signature', 'Should include thoughtSignature from toolCall');
});

test('buildFunctionCallPart - uses fallback signature when thoughtSignature missing', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  const toolCall = {
    function: { name: 'GenerateImage' }
    // No thoughtSignature
  };
  const args = { prompt: 'a cat' };
  
  const result = plugin.buildFunctionCallPart(toolCall, args);
  
  t.is(result.functionCall.name, 'GenerateImage');
  t.deepEqual(result.functionCall.args, { prompt: 'a cat' });
  t.is(result.thoughtSignature, 'skip_thought_signature_validator', 
    'Should use documented fallback signature when missing');
});

// ===== buildToolCallFromFunctionCall tests =====

test('buildToolCallFromFunctionCall - captures thoughtSignature from part.thoughtSignature', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  const part = {
    functionCall: {
      name: 'SearchInternet',
      args: { query: 'weather' }
    },
    thoughtSignature: 'sig_from_part'
  };
  
  const result = plugin.buildToolCallFromFunctionCall(part);
  
  t.is(result.function.name, 'SearchInternet');
  t.is(JSON.parse(result.function.arguments).query, 'weather');
  t.is(result.thoughtSignature, 'sig_from_part', 'Should capture thoughtSignature from part');
});

test('buildToolCallFromFunctionCall - captures thoughtSignature from functionCall.thoughtSignature', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  const part = {
    functionCall: {
      name: 'GenerateImage',
      args: { prompt: 'sunset' },
      thoughtSignature: 'sig_from_function_call'
    }
  };
  
  const result = plugin.buildToolCallFromFunctionCall(part);
  
  t.is(result.function.name, 'GenerateImage');
  t.is(result.thoughtSignature, 'sig_from_function_call', 
    'Should capture thoughtSignature from functionCall');
});

test('buildToolCallFromFunctionCall - prefers functionCall.thoughtSignature over part.thoughtSignature', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  const part = {
    functionCall: {
      name: 'TestTool',
      args: {},
      thoughtSignature: 'preferred_sig'
    },
    thoughtSignature: 'fallback_sig'
  };
  
  const result = plugin.buildToolCallFromFunctionCall(part);
  
  t.is(result.thoughtSignature, 'preferred_sig', 
    'Should prefer functionCall.thoughtSignature');
});

test('buildToolCallFromFunctionCall - handles missing thoughtSignature gracefully', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  const part = {
    functionCall: {
      name: 'SimpleTool',
      args: { value: 42 }
    }
  };
  
  const result = plugin.buildToolCallFromFunctionCall(part);
  
  t.is(result.function.name, 'SimpleTool');
  t.is(result.thoughtSignature, undefined, 
    'Should not add thoughtSignature if not present in response');
});

test('buildToolCallFromFunctionCall - handles empty args', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  const part = {
    functionCall: {
      name: 'NoArgsTool'
      // No args property
    },
    thoughtSignature: 'test_sig'
  };
  
  const result = plugin.buildToolCallFromFunctionCall(part);
  
  t.is(result.function.name, 'NoArgsTool');
  t.is(result.function.arguments, '{}', 'Should handle missing args as empty object');
  t.is(result.thoughtSignature, 'test_sig');
});

// ===== Integration-style tests for getRequestParameters =====

test('getRequestParameters - converts assistant role to model role', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  // Mock getCompiledPrompt to return messages with assistant role
  const originalGetCompiledPrompt = plugin.getCompiledPrompt.bind(plugin);
  plugin.getCompiledPrompt = (text, parameters, prompt) => {
    const result = originalGetCompiledPrompt(text, parameters, prompt);
    result.modelPromptMessages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' }
    ];
    return result;
  };
  
  const params = plugin.getRequestParameters('test', {}, { prompt: 'test' }, { pathway: {} });
  
  // The contents should have model role, not assistant
  const modelMessages = params.contents.filter(c => c.role === 'model');
  const assistantMessages = params.contents.filter(c => c.role === 'assistant');
  
  t.true(modelMessages.length > 0 || params.contents.length === 0, 
    'Should convert assistant to model role');
  t.is(assistantMessages.length, 0, 
    'Should not have any assistant role messages');
});

test('getRequestParameters - transforms function role to user role', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  // Create a mock that simulates having a function response
  const originalGetCompiledPrompt = plugin.getCompiledPrompt.bind(plugin);
  plugin.getCompiledPrompt = (text, parameters, prompt) => {
    const result = originalGetCompiledPrompt(text, parameters, prompt);
    result.modelPromptMessages = [
      { role: 'user', content: 'Search for cats' },
      { 
        role: 'assistant', 
        content: '',
        tool_calls: [{
          id: 'call_1',
          function: { name: 'SearchInternet', arguments: '{"q":"cats"}' },
          thoughtSignature: 'test_sig'
        }]
      },
      { role: 'function', content: 'Found cats', name: 'SearchInternet' }
    ];
    return result;
  };
  
  const params = plugin.getRequestParameters('test', {}, { prompt: 'test' }, { pathway: {} });
  
  // After transformation, function role should become user role
  const functionMessages = params.contents.filter(c => c.role === 'function');
  t.is(functionMessages.length, 0, 
    'Should not have any function role messages after transformation');
});

test('Gemini3ReasoningVisionPlugin - inherits from Gemini3ImagePlugin', t => {
  const resolver = createResolverWithPlugin(Gemini3ReasoningVisionPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  // Should have the parent class methods available
  t.true(typeof plugin.processStreamEvent === 'function', 
    'Should inherit processStreamEvent from parent');
  t.true(typeof plugin.getRequestParameters === 'function', 
    'Should have getRequestParameters method');
  t.true(typeof plugin.buildFunctionCallPart === 'function',
    'Should have buildFunctionCallPart method');
  t.true(typeof plugin.buildToolCallFromFunctionCall === 'function',
    'Should have buildToolCallFromFunctionCall method');
});

