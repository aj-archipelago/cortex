import test from 'ava';
import serverFactory from '../index.js';
import { PathwayResolver } from '../server/pathwayResolver.js';
import OpenAIChatPlugin from '../server/plugins/openAiChatPlugin.js';
import GeminiChatPlugin from '../server/plugins/geminiChatPlugin.js';
import Gemini15ChatPlugin from '../server/plugins/gemini15ChatPlugin.js';
import Claude3VertexPlugin from '../server/plugins/claude3VertexPlugin.js';
import { config } from '../config.js';

let testServer;

test.before(async () => {
  process.env.CORTEX_ENABLE_REST = 'true';
  const { server, startServer } = await serverFactory();
  startServer && await startServer();
  testServer = server;
});

test.after.always('cleanup', async () => {
  if (testServer) {
    await testServer.stop();
  }
});

// Helper function to create a PathwayResolver with a specific plugin
function createResolverWithPlugin(pluginClass, modelName = 'test-model') {
  // Map plugin classes to their corresponding model types
  const pluginToModelType = {
    OpenAIChatPlugin: 'OPENAI-VISION',
    GeminiChatPlugin: 'GEMINI-VISION',
    Gemini15ChatPlugin: 'GEMINI-1.5-VISION',
    Claude3VertexPlugin: 'CLAUDE-3-VERTEX'
  };

  const modelType = pluginToModelType[pluginClass.name];
  if (!modelType) {
    throw new Error(`Unknown plugin class: ${pluginClass.name}`);
  }

  const pathway = {
    name: 'test-pathway',
    model: modelName,
    prompt: 'test prompt'
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

// Test OpenAI Chat Plugin Streaming
test('OpenAI Chat Plugin - processStreamEvent handles content chunks correctly', async t => {
  const resolver = createResolverWithPlugin(OpenAIChatPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  // Test regular content chunk
  const contentEvent = {
    data: JSON.stringify({
      id: 'test-id',
      choices: [{
        delta: { content: 'test content' },
        finish_reason: null
      }]
    })
  };
  
  let progress = plugin.processStreamEvent(contentEvent, {});
  t.is(progress.data, contentEvent.data);
  t.falsy(progress.progress);
  
  // Test stream end
  const endEvent = {
    data: JSON.stringify({
      id: 'test-id',
      choices: [{
        delta: {},
        finish_reason: 'stop'
      }]
    })
  };
  
  progress = plugin.processStreamEvent(endEvent, {});
  t.is(progress.progress, 1);
});

// Test Gemini Chat Plugin Streaming
test('Gemini Chat Plugin - processStreamEvent handles content chunks correctly', async t => {
  const resolver = createResolverWithPlugin(GeminiChatPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  // Test regular content chunk
  const contentEvent = {
    data: JSON.stringify({
      candidates: [{
        content: {
          parts: [{ text: 'test content' }]
        },
        finishReason: null
      }]
    })
  };
  
  let progress = plugin.processStreamEvent(contentEvent, {});
  t.truthy(progress.data, 'Should have data');
  const parsedData = JSON.parse(progress.data);
  t.truthy(parsedData.candidates, 'Should have candidates array');
  t.truthy(parsedData.candidates[0].content, 'Should have content object');
  t.truthy(parsedData.candidates[0].content.parts, 'Should have parts array');
  t.is(parsedData.candidates[0].content.parts[0].text, 'test content', 'Content should match');
  t.falsy(progress.progress);
  
  // Test stream end with STOP
  const endEvent = {
    data: JSON.stringify({
      candidates: [{
        content: {
          parts: [{ text: '' }]
        },
        finishReason: 'STOP'
      }]
    })
  };
  
  progress = plugin.processStreamEvent(endEvent, {});
  t.is(progress.progress, 1);
});

// Test Gemini 15 Chat Plugin Streaming
test('Gemini 15 Chat Plugin - processStreamEvent handles safety blocks', async t => {
  const resolver = createResolverWithPlugin(Gemini15ChatPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  // Test safety block
  const safetyEvent = {
    data: JSON.stringify({
      candidates: [{
        safetyRatings: [{ blocked: true }]
      }]
    })
  };
  
  const progress = plugin.processStreamEvent(safetyEvent, {});
  t.true(progress.data.includes('Response blocked'));
  t.is(progress.progress, 1);
});

// Test Claude 3 Vertex Plugin Streaming
test('Claude 3 Vertex Plugin - processStreamEvent handles message types', async t => {
  const resolver = createResolverWithPlugin(Claude3VertexPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  // Test message start
  const startEvent = {
    data: JSON.stringify({
      type: 'message_start',
      message: { id: 'test-id' }
    })
  };
  
  let progress = plugin.processStreamEvent(startEvent, {});
  t.true(JSON.parse(progress.data).choices[0].delta.role === 'assistant');
  
  // Test content block
  const contentEvent = {
    data: JSON.stringify({
      type: 'content_block_delta',
      delta: {
        type: 'text_delta',
        text: 'test content'
      }
    })
  };
  
  progress = plugin.processStreamEvent(contentEvent, {});
  t.true(JSON.parse(progress.data).choices[0].delta.content === 'test content');
  
  // Test message stop
  const stopEvent = {
    data: JSON.stringify({
      type: 'message_stop'
    })
  };
  
  progress = plugin.processStreamEvent(stopEvent, {});
  t.is(progress.progress, 1);
});