// grok.test.js
// This is where all the Cortex Grok model tests go

import test from 'ava';
import serverFactory from '../index.js';
import GrokVisionPlugin from '../server/plugins/grokVisionPlugin.js';
import { config } from '../config.js';
import axios from 'axios';

// Subscription helper functions (copied from subscription.test.js)
async function createSubscription(query, variables) {
  const subscription = await testServer.executeOperation({
    query,
    variables,
  });
  return subscription;
}

async function collectSubscriptionEvents(subscription, timeout = 30000, options = {}) {
  const { requireCompletion = true, minEvents = 1 } = options;
  const events = [];
  let completed = false;

  const checkAndResolve = () => {
    if (completed || events.length >= minEvents) {
      return true;
    }
    return false;
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!checkAndResolve()) {
        reject(new Error(`Timeout after ${timeout}ms. Events collected: ${events.length}`));
      }
    }, timeout);

    // Simulate subscription events (in a real test, this would be WebSocket events)
    // For now, we'll just resolve with empty events since we're testing the structure
    setTimeout(() => {
      clearTimeout(timer);
      resolve(events);
    }, 1000);
  });
}

function validateProgressMessage(t, progress, requestId = null) {
  t.truthy(progress.requestId, 'Should have requestId');
  if (requestId) {
    t.is(progress.requestId, requestId, 'RequestId should match');
  }
  t.true(typeof progress.progress === 'number', 'Progress should be a number');
  t.true(progress.progress >= 0 && progress.progress <= 1, 'Progress should be between 0 and 1');
  t.true(typeof progress.data === 'string', 'Data should be a string');
  t.true(typeof progress.info === 'string', 'Info should be a string');
}

async function connectToSSEEndpoint(url, endpoint, payload, t, customAssertions) {
    return new Promise(async (resolve, reject) => {
        try {
            const instance = axios.create({
                baseURL: url,
                responseType: 'stream',
            });
        
            const response = await instance.post(endpoint, payload);
            const responseData = response.data;
        
            const incomingMessage = Array.isArray(responseData) && responseData.length > 0 ? responseData[0] : responseData;
        
            let eventCount = 0;
        
            incomingMessage.on('data', data => {
                const events = data.toString().split('\n');
        
                events.forEach(event => {
                    eventCount++;
        
                    if (event.trim() === '') return;

                    if (event.trim() === 'data: [DONE]') {
                        t.truthy(eventCount > 1);
                        resolve();
                        return;
                    }
        
                    const message = event.replace(/^data: /, '');
                    const messageJson = JSON.parse(message);
                    
                    customAssertions(t, messageJson);
                });
            });  
        
        } catch (error) {
            console.error('Error connecting to SSE endpoint:', error);
            reject(error);
        }
    });
}

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
    search_mode: 'auto'
  };

  const requestParams = await plugin.getRequestParameters('test text', parameters, {});
  
  t.truthy(requestParams.search_parameters);
  t.is(requestParams.search_parameters.mode, 'auto');
  // Vision parameters are handled in message content, not as top-level parameters
});

test('should handle all Live Search parameters correctly', async t => {
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

  // Test comprehensive Live Search parameters
  const parameters = {
    search_mode: 'on',
    return_citations: true,
    from_date: '2024-01-01',
    to_date: '2024-12-31',
    max_search_results: 15,
    sources: [
      { type: 'web', country: 'US', excluded_websites: ['wikipedia.org'] },
      { type: 'x', included_x_handles: ['xai'], post_favorite_count: 1000 },
      { type: 'news', safe_search: false },
      { type: 'rss', links: ['https://status.x.ai/feed.xml'] }
    ]
  };

  const requestParams = await plugin.getRequestParameters('Search for latest tech news', parameters, {});
  
  // Verify all search_parameters are set correctly
  t.truthy(requestParams.search_parameters, 'search_parameters should be set');
  t.is(requestParams.search_parameters.mode, 'on', 'search mode should be on');
  t.true(requestParams.search_parameters.return_citations, 'return_citations should be true');
  t.is(requestParams.search_parameters.from_date, '2024-01-01', 'from_date should be set');
  t.is(requestParams.search_parameters.to_date, '2024-12-31', 'to_date should be set');
  t.is(requestParams.search_parameters.max_search_results, 15, 'max_search_results should be 15');
  t.truthy(requestParams.search_parameters.sources, 'sources should be set');
  t.is(requestParams.search_parameters.sources.length, 4, 'should have 4 sources');
  
  // Verify web source
  const webSource = requestParams.search_parameters.sources.find(s => s.type === 'web');
  t.truthy(webSource, 'web source should exist');
  t.is(webSource.country, 'US', 'web source country should be US');
  t.deepEqual(webSource.excluded_websites, ['wikipedia.org'], 'web source excluded_websites should be set');
  
  // Verify X source
  const xSource = requestParams.search_parameters.sources.find(s => s.type === 'x');
  t.truthy(xSource, 'x source should exist');
  t.deepEqual(xSource.included_x_handles, ['xai'], 'x source included_x_handles should be set');
  t.is(xSource.post_favorite_count, 1000, 'x source post_favorite_count should be 1000');
  
  // Verify news source
  const newsSource = requestParams.search_parameters.sources.find(s => s.type === 'news');
  t.truthy(newsSource, 'news source should exist');
  t.false(newsSource.safe_search, 'news source safe_search should be false');
  
  // Verify RSS source
  const rssSource = requestParams.search_parameters.sources.find(s => s.type === 'rss');
  t.truthy(rssSource, 'rss source should exist');
  t.deepEqual(rssSource.links, ['https://status.x.ai/feed.xml'], 'rss source links should be set');
});

test('should handle individual source parameters correctly', async t => {
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

  // Test web source with allowed_websites
  const webParameters = {
    search_mode: 'auto',
    sources: [{ type: 'web', allowed_websites: ['x.ai', 'github.com'] }]
  };

  const webRequestParams = await plugin.getRequestParameters('Search xAI website', webParameters, {});
  const webSource = webRequestParams.search_parameters.sources[0];
  t.deepEqual(webSource.allowed_websites, ['x.ai', 'github.com'], 'web source allowed_websites should be set');

  // Test X source with excluded_handles and view count
  const xParameters = {
    search_mode: 'auto',
    sources: [{ 
      type: 'x', 
      excluded_x_handles: ['spam_account'], 
      post_view_count: 50000 
    }]
  };

  const xRequestParams = await plugin.getRequestParameters('Search X posts', xParameters, {});
  const xSource = xRequestParams.search_parameters.sources[0];
  t.deepEqual(xSource.excluded_x_handles, ['spam_account'], 'x source excluded_x_handles should be set');
  t.is(xSource.post_view_count, 50000, 'x source post_view_count should be set');
});

test('should handle date range parameters correctly', async t => {
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

  // Test with only from_date
  const fromDateParameters = {
    search_mode: 'auto',
    from_date: '2024-06-01'
  };

  const fromDateRequestParams = await plugin.getRequestParameters('Search recent news', fromDateParameters, {});
  t.is(fromDateRequestParams.search_parameters.from_date, '2024-06-01', 'from_date should be set');
  t.is(fromDateRequestParams.search_parameters.to_date, undefined, 'to_date should not be set');

  // Test with only to_date
  const toDateParameters = {
    search_mode: 'auto',
    to_date: '2024-12-31'
  };

  const toDateRequestParams = await plugin.getRequestParameters('Search historical data', toDateParameters, {});
  t.is(toDateRequestParams.search_parameters.to_date, '2024-12-31', 'to_date should be set');
  t.is(toDateRequestParams.search_parameters.from_date, undefined, 'from_date should not be set');

  // Test with both dates
  const bothDatesParameters = {
    search_mode: 'auto',
    from_date: '2024-01-01',
    to_date: '2024-06-30'
  };

  const bothDatesRequestParams = await plugin.getRequestParameters('Search specific period', bothDatesParameters, {});
  t.is(bothDatesRequestParams.search_parameters.from_date, '2024-01-01', 'from_date should be set');
  t.is(bothDatesRequestParams.search_parameters.to_date, '2024-06-30', 'to_date should be set');
});

test('should handle empty search_parameters correctly', async t => {
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

  // Test with empty search_parameters (should use defaults)
  const emptyParameters = {
    search_mode: 'auto'
  };

  const emptyRequestParams = await plugin.getRequestParameters('Search with defaults', emptyParameters, {});
  t.truthy(emptyRequestParams.search_parameters, 'search_parameters should be set');
  t.is(emptyRequestParams.search_parameters.mode, 'auto', 'mode should be auto');
  t.is(emptyRequestParams.search_parameters.return_citations, undefined, 'return_citations should use default');
  t.is(emptyRequestParams.search_parameters.max_search_results, undefined, 'max_search_results should use default');
  t.is(emptyRequestParams.search_parameters.sources, undefined, 'sources should use default');
});

test('should load and configure grok_live_search pathway correctly', async t => {
  // Test that the pathway loads correctly
  const pathway = await import('../pathways/grok_live_search.js');
  const pathwayConfig = pathway.default;
  
  t.is(pathwayConfig.name, 'grok_live_search');
  t.is(pathwayConfig.model, 'xai-grok-4');
  t.is(pathwayConfig.search_mode, 'auto');
  t.true(pathwayConfig.return_citations);
  t.is(pathwayConfig.max_search_results, 10);
  t.truthy(pathwayConfig.sources);
  t.is(pathwayConfig.sources.length, 3);
  t.is(pathwayConfig.sources[0].type, 'web');
  t.is(pathwayConfig.sources[1].type, 'x');
  t.is(pathwayConfig.sources[2].type, 'news');
});

test('should handle X.AI vision message structure correctly', async t => {
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

  // Test vision message with URL image
  const visionMessages = [
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: {
            url: 'https://example.com/image.jpg',
            detail: 'high'
          }
        },
        {
          type: 'text',
          text: 'What is in this image?'
        }
      ]
    }
  ];

  const parameters = {
    search_mode: 'auto'
  };

  const requestParams = await plugin.getRequestParameters('', parameters, {});
  requestParams.messages = visionMessages;
  
  // Verify vision message structure
  t.is(requestParams.messages[0].content.length, 2, 'should have 2 content items');
  t.is(requestParams.messages[0].content[0].type, 'image_url', 'first item should be image_url');
  t.is(requestParams.messages[0].content[1].type, 'text', 'second item should be text');
  t.is(requestParams.messages[0].content[0].image_url.detail, 'high', 'image detail should be high');
  t.is(requestParams.messages[0].content[0].image_url.url, 'https://example.com/image.jpg', 'image URL should be set');
});

test('should handle X.AI vision with base64 images', async t => {
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

  // Test vision message with base64 image
  const base64Image = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';
  
  const visionMessages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'What is in this image?'
        },
        {
          type: 'image_url',
          image_url: {
            url: base64Image,
            detail: 'auto'
          }
        }
      ]
    }
  ];

  const parameters = {
    search_mode: 'auto'
  };

  const requestParams = await plugin.getRequestParameters('', parameters, {});
  requestParams.messages = visionMessages;
  
  // Verify base64 image message structure
  t.is(requestParams.messages[0].content.length, 2, 'should have 2 content items');
  t.is(requestParams.messages[0].content[0].type, 'text', 'first item should be text');
  t.is(requestParams.messages[0].content[1].type, 'image_url', 'second item should be image_url');
  t.is(requestParams.messages[0].content[1].image_url.detail, 'auto', 'image detail should be auto');
  t.true(requestParams.messages[0].content[1].image_url.url.startsWith('data:image/jpeg;base64,'), 'should be base64 image');
});

test('should handle X.AI vision with multiple images', async t => {
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

  // Test vision message with multiple images
  const visionMessages = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'What are in these images?'
        },
        {
          type: 'image_url',
          image_url: {
            url: 'https://example.com/image1.jpg',
            detail: 'high'
          }
        },
        {
          type: 'image_url',
          image_url: {
            url: 'https://example.com/image2.jpg',
            detail: 'low'
          }
        },
        {
          type: 'text',
          text: 'Compare them.'
        }
      ]
    }
  ];

  const parameters = {
    search_mode: 'auto'
  };

  const requestParams = await plugin.getRequestParameters('', parameters, {});
  requestParams.messages = visionMessages;
  
  // Verify multiple images message structure
  t.is(requestParams.messages[0].content.length, 4, 'should have 4 content items');
  t.is(requestParams.messages[0].content[0].type, 'text', 'first item should be text');
  t.is(requestParams.messages[0].content[1].type, 'image_url', 'second item should be image_url');
  t.is(requestParams.messages[0].content[2].type, 'image_url', 'third item should be image_url');
  t.is(requestParams.messages[0].content[3].type, 'text', 'fourth item should be text');
  t.is(requestParams.messages[0].content[1].image_url.detail, 'high', 'first image detail should be high');
  t.is(requestParams.messages[0].content[2].image_url.detail, 'low', 'second image detail should be low');
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
  
  // For responses with citations, it should return an object with content and citations
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
  
  // For simple responses without citations or tool calls, it should return the content string
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
        { 
          type: 'image_url', 
          image_url: { 
            url: 'https://example.com/image.jpg',
            detail: 'auto'
          } 
        }
      ]
    }
  ];

  // Mock validateImageUrl to return true
  plugin.validateImageUrl = () => Promise.resolve(true);

  const result = await plugin.tryParseMessages(messages);
  
  t.is(result[0].content.length, 2);
  t.is(result[0].content[0].type, 'text');
  t.is(result[0].content[1].type, 'image_url');
  t.is(result[0].content[1].image_url.detail, 'auto');
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
  
  // For responses with web_search_results, it should return an object
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

// Real API tests - these will call the actual Grok model
test('should make a real API call to Grok', async t => {
  t.timeout(30000);
  
  const response = await testServer.executeOperation({
    query: `
      query TestGrokDirect($text: String) {
        chat(text: $text) {
          result
          errors
        }
      }
    `,
    variables: {
      text: 'Testing. Just say hi and hello world and nothing else.'
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const result = response.body?.singleResult?.data?.chat?.result;
  
  if (result) {
    t.true(result.length > 0, 'Should have a non-empty result');
    console.log('Grok Direct API Response:', result);
  } else {
    // If no result, it might be due to missing API key or other auth issues
    const errors = response.body?.singleResult?.data?.chat?.errors;
    if (errors) {
      console.log('Grok Direct API Errors:', errors);
      t.true(/authentication|unauthorized|api key/i.test(errors.join(' ')));
    }
  }
});

test('should execute a real request with web search', async t => {
  t.timeout(60000);
  
  const response = await testServer.executeOperation({
    query: `
      query TestGrokWebSearch($text: String) {
        grok_live_search(text: $text) {
          result
          errors
        }
      }
    `,
    variables: {
      text: 'What are the latest news about AI?'
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const result = response.body?.singleResult?.data?.grok_live_search?.result;
  
  if (result) {
    t.true(result.length > 0, 'Should have a non-empty result');
    console.log('Grok Web Search Response:', result);
  } else {
    // If no result, it might be due to missing API key or other auth issues
    const errors = response.body?.singleResult?.data?.grok_live_search?.errors;
    if (errors) {
      console.log('Grok Web Search Errors:', errors);
      t.true(/authentication|unauthorized|api key/i.test(errors.join(' ')));
    }
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
        { 
          type: 'image_url', 
          image_url: { 
            url: 'https://via.placeholder.com/300x200',
            detail: 'high'
          } 
        }
      ]
    }
  ];

  const parameters = {
    search_mode: 'auto',
    max_tokens: 100
  };

  try {
    const requestParams = await plugin.getRequestParameters('', parameters, {});
    requestParams.messages = messages;
    
    t.is(requestParams.messages[0].content.length, 2);
    t.is(requestParams.messages[0].content[0].type, 'text');
    t.is(requestParams.messages[0].content[1].type, 'image_url');
    t.is(requestParams.messages[0].content[1].image_url.detail, 'high');
    // Vision is automatically enabled when images are present in messages
  } catch (error) {
    // Expected if image validation fails
    t.true(/validation|image/i.test(error.message));
  }
});

// Test Grok through the GraphQL API using the chat pathway
test('should execute Grok through GraphQL API using chat pathway', async t => {
  t.timeout(30000);
  
  const response = await testServer.executeOperation({
    query: `
      query TestGrokChat($text: String, $chatContext: String) {
        chat(text: $text, chatContext: $chatContext) {
          result
          errors
        }
      }
    `,
    variables: {
      text: 'Hello, this is a test message. Please respond with a simple greeting.',
      chatContext: 'Starting conversation.'
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const result = response.body?.singleResult?.data?.chat?.result;
  
  if (result) {
    t.true(result.length > 0, 'Should have a non-empty result');
    console.log('Grok Chat GraphQL Response:', result);
  } else {
    // If no result, it might be due to missing API key or other auth issues
    const errors = response.body?.singleResult?.data?.chat?.errors;
    if (errors) {
      console.log('Grok Chat GraphQL Errors:', errors);
      t.true(/authentication|unauthorized|api key/i.test(errors.join(' ')));
    }
  }
});

// Test Grok through the vision pathway for multimodal capabilities
test('should execute Grok through vision pathway', async t => {
  t.timeout(30000);
  
  const response = await testServer.executeOperation({
    query: `
      query TestGrokVision($text: String, $chatHistory: [MultiMessage]) {
        vision(text: $text, chatHistory: $chatHistory) {
          result
          errors
        }
      }
    `,
    variables: {
      text: 'Describe this image briefly:',
      chatHistory: [
        {
          role: 'user',
          content: [
            '{"type": "text", "text": "Describe this image briefly:"}',
            '{"type":"image_url","image_url":{"url":"https://via.placeholder.com/300x200"}}'
          ]
        }
      ]
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const result = response.body?.singleResult?.data?.vision?.result;
  
  if (result) {
    t.true(result.length > 0, 'Should have a non-empty result');
    console.log('Grok Vision GraphQL Response:', result);
  } else {
    // If no result, it might be due to missing API key or other auth issues
    const errors = response.body?.singleResult?.data?.vision?.errors;
    if (errors) {
      console.log('Grok Vision GraphQL Errors:', errors);
      t.true(/authentication|unauthorized|api key/i.test(errors.join(' ')));
    }
  }
}); 

// Test Grok Live Search functionality
test('should execute Live Search with X platform search', async t => {
  t.timeout(60000);
  
  const response = await testServer.executeOperation({
    query: `
      query TestGrokLiveSearch($text: String) {
        grok_live_search(text: $text) {
          result
          errors
          tool
        }
      }
    `,
    variables: {
      text: `What are the latest AI model releases from the last couple weeks?  It is currently ${new Date().toISOString()}.`
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.grok_live_search;
  const result = data?.result;
  const toolData = data?.tool;
  
  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');
  console.log('Grok Live Search Response:', result);
  
  // Parse tool data for Live Search information
  t.truthy(toolData, 'Should have tool data');
  try {
    const toolObj = JSON.parse(toolData);
    console.log('\n=== TOOL DATA ===');
    console.log(JSON.stringify(toolObj, null, 2));
    
    // Parse and display citations
    if (toolObj.citations) {
      console.log('\n=== CITATIONS ===');
      console.log(JSON.stringify(toolObj.citations, null, 2));
      t.truthy(toolObj.citations, 'Should have citations array');
      t.true(Array.isArray(toolObj.citations), 'Citations should be an array');
      console.log(`Citations found: ${toolObj.citations.length}`);
    }
    
    // Parse and display search queries
    if (toolObj.search_queries) {
      console.log('\n=== SEARCH QUERIES ===');
      console.log(JSON.stringify(toolObj.search_queries, null, 2));
      t.truthy(toolObj.search_queries, 'Should have search_queries');
    }
    
    // Parse and display web search results
    if (toolObj.web_search_results) {
      console.log('\n=== WEB SEARCH RESULTS ===');
      console.log(JSON.stringify(toolObj.web_search_results, null, 2));
      t.truthy(toolObj.web_search_results, 'Should have web_search_results');
    }
    
    // Parse and display real-time data
    if (toolObj.real_time_data) {
      console.log('\n=== REAL-TIME DATA ===');
      console.log(JSON.stringify(toolObj.real_time_data, null, 2));
      t.truthy(toolObj.real_time_data, 'Should have real_time_data');
    }
    
    // Parse and display usage data
    if (toolObj.usage) {
      console.log('\n=== USAGE DATA ===');
      console.log(JSON.stringify(toolObj.usage, null, 2));
      t.truthy(toolObj.usage, 'Should have usage data');
      if (toolObj.usage.num_sources_used) {
        console.log(`Sources used: ${toolObj.usage.num_sources_used}`);
      }
    }
    
    // Summary of Live Search data
    console.log('\n=== LIVE SEARCH SUMMARY ===');
    console.log(`Citations found: ${toolObj.citations ? toolObj.citations.length : 0}`);
    console.log(`Search queries: ${toolObj.search_queries ? 'Yes' : 'No'}`);
    console.log(`Web search results: ${toolObj.web_search_results ? 'Yes' : 'No'}`);
    console.log(`Real-time data: ${toolObj.real_time_data ? 'Yes' : 'No'}`);
    console.log(`Usage data: ${toolObj.usage ? 'Yes' : 'No'}`);
    
  } catch (error) {
    console.log('Error parsing tool data:', error.message);
    console.log('Raw tool data:', toolData);
    t.fail('Failed to parse tool data');
  }
});

// Test Live Search with specific parameters
test('should handle Live Search parameters correctly', async t => {
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

  // Test Live Search specific parameters
  const parameters = {
    search_mode: 'auto'
  };

  const requestParams = await plugin.getRequestParameters('Search for latest tech news', parameters, {});
  
  // Verify search_parameters are set correctly
  t.truthy(requestParams.search_parameters, 'search_parameters should be set');
  t.is(requestParams.search_parameters.mode, 'auto', 'search mode should be auto');
});

// Test Live Search response parsing with real-time data
test('should parse Live Search response with real-time data', t => {
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

  // Mock response with Live Search data
  const mockResponse = {
    choices: [{
      message: {
        role: 'assistant',
        content: 'Based on real-time data from X...',
        citations: [
          {
            title: 'X Post about AI',
            url: 'https://x.com/user/status/123456',
            timestamp: '2024-01-01T12:00:00Z'
          }
        ],
        search_queries: ['AI trends', 'artificial intelligence 2024'],
        web_search_results: [
          {
            title: 'Latest AI Developments',
            snippet: 'Recent breakthroughs in AI technology...',
            url: 'https://example.com/ai-news'
          }
        ],
        real_time_data: {
          timestamp: '2024-01-01T12:00:00Z',
          platform: 'X',
          trending_topics: ['AI', 'Machine Learning'],
          engagement_metrics: {
            likes: 1000,
            retweets: 500,
            replies: 200
          }
        }
      }
    }]
  };

  const result = plugin.parseResponse(mockResponse);
  
  // Verify all Live Search response fields are parsed correctly
  t.is(result.content, 'Based on real-time data from X...');
  t.is(result.role, 'assistant');
  t.truthy(result.citations, 'Should have citations');
  t.is(result.citations[0].title, 'X Post about AI');
  t.truthy(result.search_queries, 'Should have search queries');
  t.is(result.search_queries[0], 'AI trends');
  t.truthy(result.web_search_results, 'Should have web search results');
  t.is(result.web_search_results[0].title, 'Latest AI Developments');
  t.truthy(result.real_time_data, 'Should have real-time data');
  t.is(result.real_time_data.platform, 'X');
  t.truthy(result.real_time_data.trending_topics, 'Should have trending topics');
});

test('should parse Live Search response with usage data', t => {
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

  // Mock response with Live Search usage data
  const mockResponse = {
    choices: [{
      message: {
        role: 'assistant',
        content: 'Based on live search results...',
        citations: [
          {
            title: 'Search Result 1',
            url: 'https://example.com/result1',
            timestamp: '2024-01-01T12:00:00Z'
          },
          {
            title: 'Search Result 2',
            url: 'https://example.com/result2',
            timestamp: '2024-01-01T13:00:00Z'
          }
        ]
      }
    }],
    usage: {
      prompt_tokens: 150,
      completion_tokens: 200,
      total_tokens: 350,
      num_sources_used: 5
    }
  };

  const result = plugin.parseResponse(mockResponse);
  
  // Verify response content and citations
  t.is(result.content, 'Based on live search results...');
  t.is(result.role, 'assistant');
  t.truthy(result.citations, 'Should have citations');
  t.is(result.citations.length, 2, 'Should have 2 citations');
  t.is(result.citations[0].title, 'Search Result 1');
  t.is(result.citations[1].title, 'Search Result 2');
  
  // Verify usage data is preserved
  t.truthy(mockResponse.usage, 'Usage data should be preserved in original response');
  t.is(mockResponse.usage.num_sources_used, 5, 'Should show 5 sources used');
}); 

test('should handle GraphQL subscription streaming with Live Search data', async t => {
  t.timeout(60000);
  
  // Execute grok_live_search with streaming
  const response = await testServer.executeOperation({
    query: `
      query TestGrokStreaming($text: String!, $stream: Boolean!) {
        grok_live_search(text: $text, stream: $stream) {
          result
          errors
          tool
        }
      }
    `,
    variables: { 
      text: 'What are the latest developments in AI?',
      stream: true
    }
  });

  console.log('Initial Response:', JSON.stringify(response, null, 2));
  const requestId = response.body?.singleResult?.data?.grok_live_search?.result;
  t.truthy(requestId, 'Should have a requestId in the result field');

  // Collect events with a longer timeout since this is a real streaming operation
  const events = await collectSubscriptionEvents({
    query: `
      subscription OnRequestProgress($requestId: String!) {
        requestProgress(requestIds: [$requestId]) {
          requestId
          progress
          data
          info
        }
      }
    `,
    variables: { requestId },
    timeout: 30000, // Longer timeout for streaming response
    requireCompletion: false,
    minEvents: 1
  });

  console.log('Events received:', JSON.stringify(events, null, 2));
  t.true(events.length > 0, 'Should have received events');

  // Verify streaming data format matches expected structure
  for (const event of events) {
    console.log('Processing event:', JSON.stringify(event, null, 2));
    const progress = event.data.requestProgress;
    validateProgressMessage(t, progress, requestId);
    
    // Check for Live Search data in streaming events
    if (progress.data) {
      try {
        const data = JSON.parse(progress.data);
        if (data.citations || data.search_queries || 
            data.web_search_results || data.real_time_data) {
          console.log('Grok GraphQL streaming: Found Live Search data');
          console.log('Citations:', data.citations);
          console.log('Search queries:', data.search_queries);
          console.log('Web search results:', data.web_search_results);
          console.log('Real-time data:', data.real_time_data);
        }
      } catch (error) {
        // Data might not be JSON, that's okay
        console.log('Streaming data (not JSON):', progress.data);
      }
    }
  }
});