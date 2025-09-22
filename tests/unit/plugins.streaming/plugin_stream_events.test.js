import test from 'ava';
import { PathwayResolver } from '../../../server/pathwayResolver.js';
import OpenAIChatPlugin from '../../../server/plugins/openAiChatPlugin.js';
import GeminiChatPlugin from '../../../server/plugins/geminiChatPlugin.js';
import Gemini15ChatPlugin from '../../../server/plugins/gemini15ChatPlugin.js';
import Claude3VertexPlugin from '../../../server/plugins/claude3VertexPlugin.js';
import { config } from '../../../config.js';

let testServer;

function createResolverWithPlugin(pluginClass, modelName = 'test-model') {
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

test('OpenAI Chat Plugin - processStreamEvent handles content chunks correctly', async t => {
  const resolver = createResolverWithPlugin(OpenAIChatPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
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

test('Gemini Chat Plugin - processStreamEvent handles content chunks correctly', async t => {
  const resolver = createResolverWithPlugin(GeminiChatPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  const contentEvent = {
    data: JSON.stringify({
      candidates: [{
        content: { parts: [{ text: 'test content' }] },
        finishReason: null
      }]
    })
  };
  
  let progress = plugin.processStreamEvent(contentEvent, {});
  t.truthy(progress.data);
  const parsedData = JSON.parse(progress.data);
  t.truthy(parsedData.candidates);
  t.truthy(parsedData.candidates[0].content);
  t.truthy(parsedData.candidates[0].content.parts);
  t.is(parsedData.candidates[0].content.parts[0].text, 'test content');
  t.falsy(progress.progress);
  
  const endEvent = {
    data: JSON.stringify({
      candidates: [{
        content: { parts: [{ text: '' }] },
        finishReason: 'STOP'
      }]
    })
  };
  
  progress = plugin.processStreamEvent(endEvent, {});
  t.is(progress.progress, 1);
});

test('Gemini 15 Chat Plugin - processStreamEvent handles safety blocks', async t => {
  const resolver = createResolverWithPlugin(Gemini15ChatPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  const safetyEvent = {
    data: JSON.stringify({
      candidates: [{ safetyRatings: [{ blocked: true }] }]
    })
  };
  
  const progress = plugin.processStreamEvent(safetyEvent, {});
  t.true(progress.data.includes('Response blocked'));
  t.is(progress.progress, 1);
});

test('Claude 3 Vertex Plugin - processStreamEvent handles message types', async t => {
  const resolver = createResolverWithPlugin(Claude3VertexPlugin);
  const plugin = resolver.modelExecutor.plugin;
  
  const startEvent = {
    data: JSON.stringify({
      type: 'message_start',
      message: { id: 'test-id' }
    })
  };
  
  let progress = plugin.processStreamEvent(startEvent, {});
  t.true(JSON.parse(progress.data).choices[0].delta.role === 'assistant');
  
  const contentEvent = {
    data: JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'test content' }
    })
  };
  
  progress = plugin.processStreamEvent(contentEvent, {});
  t.true(JSON.parse(progress.data).choices[0].delta.content === 'test content');
  
  const stopEvent = { data: JSON.stringify({ type: 'message_stop' }) };
  
  progress = plugin.processStreamEvent(stopEvent, {});
  t.is(progress.progress, 1);
});


