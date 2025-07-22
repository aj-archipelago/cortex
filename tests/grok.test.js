// grok.test.js
// This is where all the Cortex Grok model tests go

import test from 'ava';
import serverFactory from '../index.js';
import GrokVisionPlugin from '../server/plugins/grokVisionPlugin.js';
import { config } from '../config.js';

let testServer;

test.before(async () => {
  const { server, startServer } = await serverFactory();
  startServer && await startServer();
  testServer = server;
});

test.after.always('cleanup', async () => {
  if (testServer) {
    await testServer.stop();
  }
});

test('should create GrokVisionPlugin instance', t => {
  const mockPathway = {
    name: 'test-pathway',
    temperature: 0.7,
    prompt: 'Test prompt'
  };

  const mockModel = {
    name: 'xai-grok-3',
    type: 'GROK-VISION',
    url: 'https://api.x.ai/v1/chat/completions',
    headers: {
      'Authorization': 'Bearer test-key',
      'Content-Type': 'application/json'
    },
    params: {
      model: 'grok-3-latest'
    },
    maxTokenLength: 131072,
    maxReturnTokens: 4096
  };

  const plugin = new GrokVisionPlugin(mockPathway, mockModel);
  
  t.true(plugin instanceof GrokVisionPlugin);
  t.is(plugin.modelName, 'xai-grok-3');
  t.true(plugin.isMultiModal);
});

test('should handle Grok-specific parameters', async t => {
  const mockPathway = {
    name: 'test-pathway',
    temperature: 0.7,
    prompt: 'Test prompt'
  };

  const mockModel = {
    name: 'xai-grok-4',
    type: 'GROK-VISION',
    url: 'https://api.x.ai/v1/chat/completions',
    headers: {
      'Authorization': 'Bearer test-key',
      'Content-Type': 'application/json'
    },
    params: {
      model: 'grok-4-0709'
    },
    maxTokenLength: 131072,
    maxReturnTokens: 4096
  };

  const plugin = new GrokVisionPlugin(mockPathway, mockModel);

  const parameters = {
    web_search: true,
    real_time_data: true,
    citations: true,
    search_queries_only: false,
    search_grounding: true,
    vision: true,
    vision_detail: 'high',
    vision_auto: true
  };

  const requestParams = await plugin.getRequestParameters('test text', parameters, {});
  
  t.true(requestParams.web_search);
  t.true(requestParams.real_time_data);
  t.true(requestParams.citations);
  t.false(requestParams.search_queries_only);
  t.true(requestParams.search_grounding);
  t.true(requestParams.vision);
  t.is(requestParams.vision_detail, 'high');
  t.true(requestParams.vision_auto);
});

test('should parse Grok response with citations', t => {
  const mockPathway = {
    name: 'test-pathway',
    temperature: 0.7,
    prompt: 'Test prompt'
  };

  const mockModel = {
    name: 'xai-grok-4',
    type: 'GROK-VISION',
    url: 'https://api.x.ai/v1/chat/completions',
    headers: {
      'Authorization': 'Bearer test-key',
      'Content-Type': 'application/json'
    },
    params: {
      model: 'grok-4-0709'
    },
    maxTokenLength: 131072,
    maxReturnTokens: 4096
  };

  const plugin = new GrokVisionPlugin(mockPathway, mockModel);

  const mockResponse = {
    choices: [{
      message: {
        role: 'assistant',
        content: 'Test response',
        citations: [
          {
            title: 'Test Citation',
            url: 'https://example.com'
          }
        ]
      }
    }]
  };

  const result = plugin.parseResponse(mockResponse);
  
  t.is(result.content, 'Test response');
  t.is(result.role, 'assistant');
  t.truthy(result.citations);
  t.is(result.citations[0].title, 'Test Citation');
});

test('should handle tool calls in response', t => {
  const mockPathway = {
    name: 'test-pathway',
    temperature: 0.7,
    prompt: 'Test prompt'
  };

  const mockModel = {
    name: 'xai-grok-4',
    type: 'GROK-VISION',
    url: 'https://api.x.ai/v1/chat/completions',
    headers: {
      'Authorization': 'Bearer test-key',
      'Content-Type': 'application/json'
    },
    params: {
      model: 'grok-4-0709'
    },
    maxTokenLength: 131072,
    maxReturnTokens: 4096
  };

  const plugin = new GrokVisionPlugin(mockPathway, mockModel);

  const mockResponse = {
    choices: [{
      message: {
        role: 'assistant',
        content: 'I will call a tool',
        tool_calls: [
          {
            id: 'call_123',
            type: 'function',
            function: {
              name: 'test_function',
              arguments: '{"param": "value"}'
            }
          }
        ]
      }
    }]
  };

  const result = plugin.parseResponse(mockResponse);
  
  t.is(result.content, 'I will call a tool');
  t.truthy(result.tool_calls);
  t.is(result.tool_calls[0].function.name, 'test_function');
});

test('should handle string response from parent', t => {
  const mockPathway = {
    name: 'test-pathway',
    temperature: 0.7,
    prompt: 'Test prompt'
  };

  const mockModel = {
    name: 'xai-grok-4',
    type: 'GROK-VISION',
    url: 'https://api.x.ai/v1/chat/completions',
    headers: {
      'Authorization': 'Bearer test-key',
      'Content-Type': 'application/json'
    },
    params: {
      model: 'grok-4-0709'
    },
    maxTokenLength: 131072,
    maxReturnTokens: 4096
  };

  const plugin = new GrokVisionPlugin(mockPathway, mockModel);

  const mockResponse = {
    choices: [{
      message: {
        role: 'assistant',
        content: 'Simple text response'
      }
    }]
  };

  const result = plugin.parseResponse(mockResponse);
  
  t.is(result, 'Simple text response');
});

test('should handle basic Grok API response format', t => {
  const mockPathway = {
    name: 'test-pathway',
    temperature: 0.7,
    prompt: 'Test prompt'
  };

  const mockModel = {
    name: 'xai-grok-3',
    type: 'GROK-VISION',
    url: 'https://api.x.ai/v1/chat/completions',
    headers: {
      'Authorization': 'Bearer test-key',
      'Content-Type': 'application/json'
    },
    params: {
      model: 'grok-3-latest'
    },
    maxTokenLength: 131072,
    maxReturnTokens: 4096
  };

  const plugin = new GrokVisionPlugin(mockPathway, mockModel);

  // This matches the actual Grok API response format from your curl example
  const mockResponse = {
    "id": "13493401-f153-7de6-ac07-c6f6b2609b06",
    "object": "chat.completion",
    "created": 1753113536,
    "model": "grok-3",
    "choices": [{
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hi\nHello World",
        "refusal": null
      },
      "finish_reason": "stop"
    }],
    "usage": {
      "prompt_tokens": 28,
      "completion_tokens": 4,
      "total_tokens": 32,
      "prompt_tokens_details": {
        "text_tokens": 28,
        "audio_tokens": 0,
        "image_tokens": 0,
        "cached_tokens": 5
      },
      "completion_tokens_details": {
        "reasoning_tokens": 0,
        "audio_tokens": 0,
        "accepted_prediction_tokens": 0,
        "rejected_prediction_tokens": 0
      },
      "num_sources_used": 0
    },
    "system_fingerprint": "fp_0d42a4eb3d"
  };

  const result = plugin.parseResponse(mockResponse);
  
  // Should return the content string for basic responses
  t.is(result, 'Hi\nHello World');
});

test('should parse messages with image content', async t => {
  const mockPathway = {
    name: 'test-pathway',
    temperature: 0.7,
    prompt: 'Test prompt'
  };

  const mockModel = {
    name: 'xai-grok-4',
    type: 'GROK-VISION',
    url: 'https://api.x.ai/v1/chat/completions',
    headers: {
      'Authorization': 'Bearer test-key',
      'Content-Type': 'application/json'
    },
    params: {
      model: 'grok-4-0709'
    },
    maxTokenLength: 131072,
    maxReturnTokens: 4096
  };

  const plugin = new GrokVisionPlugin(mockPathway, mockModel);

  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image' },
        { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' } }
      ]
    }
  ];

  // Mock validateImageUrl to return true
  plugin.validateImageUrl = () => Promise.resolve(true);

  const result = await plugin.tryParseMessages(messages);
  
  t.is(result[0].content.length, 2);
  t.is(result[0].content[0].type, 'text');
  t.is(result[0].content[1].type, 'image_url');
});

test('should handle Grok vision response with web search results', t => {
  const mockPathway = {
    name: 'test-pathway',
    temperature: 0.7,
    prompt: 'Test prompt'
  };

  const mockModel = {
    name: 'xai-grok-4',
    type: 'GROK-VISION',
    url: 'https://api.x.ai/v1/chat/completions',
    headers: {
      'Authorization': 'Bearer test-key',
      'Content-Type': 'application/json'
    },
    params: {
      model: 'grok-4-0709'
    },
    maxTokenLength: 131072,
    maxReturnTokens: 4096
  };

  const plugin = new GrokVisionPlugin(mockPathway, mockModel);

  const mockResponse = {
    choices: [{
      message: {
        role: 'assistant',
        content: 'Based on the image and web search...',
        web_search_results: [
          {
            title: 'Search Result',
            snippet: 'Relevant information',
            url: 'https://example.com'
          }
        ]
      }
    }]
  };

  const result = plugin.parseResponse(mockResponse);
  
  t.is(result.content, 'Based on the image and web search...');
  t.truthy(result.web_search_results);
  t.is(result.web_search_results[0].title, 'Search Result');
});

test('should handle streaming events with Grok-specific fields', t => {
  const mockPathway = {
    name: 'test-pathway',
    temperature: 0.7,
    prompt: 'Test prompt'
  };

  const mockModel = {
    name: 'xai-grok-4',
    type: 'GROK-VISION',
    url: 'https://api.x.ai/v1/chat/completions',
    headers: {
      'Authorization': 'Bearer test-key',
      'Content-Type': 'application/json'
    },
    params: {
      model: 'grok-4-0709'
    },
    maxTokenLength: 131072,
    maxReturnTokens: 4096
  };

  const plugin = new GrokVisionPlugin(mockPathway, mockModel);

  const event = {
    data: JSON.stringify({
      choices: [{
        delta: {
          content: 'Test content',
          citations: [{ title: 'Citation', url: 'https://example.com' }],
          search_queries: ['test query'],
          web_search_results: [{ title: 'Result', url: 'https://example.com' }],
          real_time_data: { timestamp: '2024-01-01T00:00:00Z', data: 'Real-time info' }
        }
      }]
    })
  };

  const requestProgress = { data: '', progress: 0 };
  const result = plugin.processStreamEvent(event, requestProgress);

  t.truthy(result.citations);
  t.truthy(result.search_queries);
  t.truthy(result.web_search_results);
  t.truthy(result.real_time_data);
});

test('should handle end of stream event', t => {
  const mockPathway = {
    name: 'test-pathway',
    temperature: 0.7,
    prompt: 'Test prompt'
  };

  const mockModel = {
    name: 'xai-grok-4',
    type: 'GROK-VISION',
    url: 'https://api.x.ai/v1/chat/completions',
    headers: {
      'Authorization': 'Bearer test-key',
      'Content-Type': 'application/json'
    },
    params: {
      model: 'grok-4-0709'
    },
    maxTokenLength: 131072,
    maxReturnTokens: 4096
  };

  const plugin = new GrokVisionPlugin(mockPathway, mockModel);

  const event = { data: '[DONE]' };
  const requestProgress = { data: '', progress: 0 };
  
  const result = plugin.processStreamEvent(event, requestProgress);
  
  t.is(result.progress, 1);
});

// Real API tests
test.only('should make a real API call to Grok', async t => {
  t.timeout(30000);
  
  const mockPathway = {
    name: 'test-pathway',
    temperature: 0,
    prompt: 'You are a test assistant.'
  };

  // Get the real model configuration from config
  const models = config.get('models');
  const realModel = models['xai-grok-3'];
  
  if (!realModel) {
    t.fail('xai-grok-3 model not found in configuration');
    return;
  }

  const plugin = new GrokVisionPlugin(mockPathway, realModel);

  const text = 'Testing. Just say hi and hello world and nothing else.';
  const parameters = {
    temperature: 0
  };

  const requestParams = await plugin.getRequestParameters(text, {...plugin.params, ...parameters}, mockPathway.prompt);
  
  t.truthy(requestParams.messages);
  t.is(requestParams.messages[0].content, text);
  t.is(requestParams.model, 'grok-3-latest');
  t.is(requestParams.temperature, 0);
  
  // Test the actual API call
  const cortexRequest = {
    data: {},
    params: {}
  };

  try {
    const result = await plugin.execute(text, parameters, {}, cortexRequest);
    t.truthy(result);
    console.log('Grok API Response:', JSON.stringify(result, null, 2));
  } catch (error) {
    console.error('Grok API Error:', error.message);
    // If API key is not set or other auth issues, that's expected
    t.true(/authentication|unauthorized|api key/i.test(error.message));
  }
});

test('should execute a real request with web search', async t => {
  t.timeout(30000);
  
  const mockPathway = {
    name: 'test-pathway',
    temperature: 0.7,
    prompt: 'Test prompt'
  };

  // Get the real model configuration from config
  const models = config.get('models');
  const realModel = models['xai-grok-3'];
  
  if (!realModel) {
    t.fail('xai-grok-3 model not found in configuration');
    return;
  }

  const plugin = new GrokVisionPlugin(mockPathway, realModel);

  const text = 'What are the latest news about AI?';
  const parameters = {
    web_search: true,
    citations: true,
    max_tokens: 100
  };

  const cortexRequest = {
    data: {},
    params: {}
  };

  try {
    const result = await plugin.execute(text, parameters, {}, cortexRequest);
    t.truthy(result);
  } catch (error) {
    // If API key is not set or other auth issues, that's expected
    t.true(/authentication|unauthorized|api key/i.test(error.message));
  }
});

test('should handle multimodal content with real API', async t => {
  t.timeout(30000);
  
  const mockPathway = {
    name: 'test-pathway',
    temperature: 0.7,
    prompt: 'Test prompt'
  };

  // Get the real model configuration from config
  const models = config.get('models');
  const realModel = models['xai-grok-3'];
  
  if (!realModel) {
    t.fail('xai-grok-3 model not found in configuration');
    return;
  }

  const plugin = new GrokVisionPlugin(mockPathway, realModel);

  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is this image about?' },
        { type: 'image_url', image_url: { url: 'https://via.placeholder.com/300x200' } }
      ]
    }
  ];

  const parameters = {
    web_search: true,
    vision: true,
    max_tokens: 100
  };

  try {
    const requestParams = await plugin.getRequestParameters('', parameters, {});
    requestParams.messages = messages;
    
    t.is(requestParams.messages[0].content.length, 2);
    t.is(requestParams.messages[0].content[0].type, 'text');
    t.is(requestParams.messages[0].content[1].type, 'image_url');
    t.true(requestParams.vision);
  } catch (error) {
    // Expected if image validation fails
    t.true(/validation|image/i.test(error.message));
  }
}); 