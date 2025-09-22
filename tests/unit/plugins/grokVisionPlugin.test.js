// grokVisionPlugin.test.js
// This file contains direct plugin tests for GrokVisionPlugin (non-connecting tests)

import test from 'ava';
import GrokVisionPlugin from '../../../server/plugins/grokVisionPlugin.js';
import { safeJsonParse } from '../../../server/plugins/grokVisionPlugin.js';

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
    search_parameters: '{"mode": "auto"}'
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

  // Test comprehensive Live Search parameters as JSON string
  const parameters = {
    search_parameters: JSON.stringify({
      mode: 'on',
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
    })
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
    search_parameters: JSON.stringify({
      mode: 'auto',
      sources: [{ type: 'web', allowed_websites: ['x.ai', 'github.com'] }]
    })
  };

  const webRequestParams = await plugin.getRequestParameters('Search xAI website', webParameters, {});
  const webSource = webRequestParams.search_parameters.sources[0];
  t.deepEqual(webSource.allowed_websites, ['x.ai', 'github.com'], 'web source allowed_websites should be set');

  // Test X source with excluded_handles and view count
  const xParameters = {
    search_parameters: JSON.stringify({
      mode: 'auto',
      sources: [{
        type: 'x',
        excluded_x_handles: ['spam_account'],
        post_view_count: 50000
      }]
    })
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
    search_parameters: JSON.stringify({
      mode: 'auto',
      from_date: '2024-06-01'
    })
  };

  const fromDateRequestParams = await plugin.getRequestParameters('Search recent news', fromDateParameters, {});
  t.is(fromDateRequestParams.search_parameters.from_date, '2024-06-01', 'from_date should be set');
  t.is(fromDateRequestParams.search_parameters.to_date, undefined, 'to_date should not be set');

  // Test with only to_date
  const toDateParameters = {
    search_parameters: JSON.stringify({
      mode: 'auto',
      to_date: '2024-12-31'
    })
  };

  const toDateRequestParams = await plugin.getRequestParameters('Search historical data', toDateParameters, {});
  t.is(toDateRequestParams.search_parameters.to_date, '2024-12-31', 'to_date should be set');
  t.is(toDateRequestParams.search_parameters.from_date, undefined, 'from_date should not be set');

  // Test with both dates
  const bothDatesParameters = {
    search_parameters: JSON.stringify({
      mode: 'auto',
      from_date: '2024-01-01',
      to_date: '2024-06-30'
    })
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

  // Test with empty search_parameters (should not be set)
  const emptyParameters = {};

  const emptyRequestParams = await plugin.getRequestParameters('Search with defaults', emptyParameters, {});
  t.is(emptyRequestParams.search_parameters, undefined, 'search_parameters should not be set when not provided');

  // Test with empty JSON string
  const emptyJsonParameters = {
    search_parameters: '{}'
  };

  const emptyJsonRequestParams = await plugin.getRequestParameters('Search with empty json', emptyJsonParameters, {});
  t.is(emptyJsonRequestParams.search_parameters, undefined, 'search_parameters should not be set when empty object provided');
});

// Note: grok_live_search pathway test removed as the pathway file does not exist yet

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

  const parameters = {};

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

  const parameters = {};

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

  const parameters = {};

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
        content: 'Test response'
      }
    }],
    citations: [
      'https://example.com'
    ]
  };

  const result = plugin.parseResponse(mockResponse);

  // Should return a CortexResponse object
  t.is(result.output_text, 'Test response');
  t.truthy(result.citations);
  // Citations are created from URLs, so title is extracted from URL
  t.is(result.citations[0].url, 'https://example.com');
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

  t.is(result.output_text, 'I will call a tool');
  t.truthy(result.toolCalls);
  t.is(result.toolCalls[0].function.name, 'test_function');
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

  // Should return a CortexResponse object for simple responses
  t.is(result.output_text, 'Simple text response');
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

  // Should return a CortexResponse object
  t.is(result.output_text, 'Hi\nHello World');
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
        content: 'Based on the image and web search...'
      }
    }],
    web_search_results: [
      {
        title: 'Search Result',
        snippet: 'Relevant information',
        url: 'https://example.com'
      }
    ]
  };

  const result = plugin.parseResponse(mockResponse);

  // Should return a CortexResponse object
  t.is(result.output_text, 'Based on the image and web search...');
  t.truthy(result.searchResults);
  t.is(result.searchResults[0].title, 'Search Result');
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

  // Should return the requestProgress object (calls parent implementation)
  t.is(result, requestProgress);
  t.is(typeof result.data, 'string');
  t.is(typeof result.progress, 'number');
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
    search_parameters: '{"mode": "auto"}'
  };

  const requestParams = await plugin.getRequestParameters('Search for latest tech news', parameters, {});

  // Verify search_parameters are set correctly
  t.truthy(requestParams.search_parameters, 'search_parameters should be set');
  t.is(requestParams.search_parameters.mode, 'auto', 'search mode should be auto');
});

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
        content: 'Based on real-time data from X...'
      }
    }],
    citations: [
      'https://x.com/user/status/123456'
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
  };

  const result = plugin.parseResponse(mockResponse);
  
  // Verify all Live Search response fields are parsed correctly
  t.is(result.output_text, 'Based on real-time data from X...');
  t.truthy(result.citations, 'Should have citations');
  t.is(result.citations[0].url, 'https://x.com/user/status/123456');
  t.truthy(result.searchQueries, 'Should have search queries');
  t.is(result.searchQueries[0], 'AI trends');
  t.truthy(result.searchResults, 'Should have web search results');
  t.is(result.searchResults[0].title, 'Latest AI Developments');
  t.truthy(result.realTimeData, 'Should have real-time data');
  t.is(result.realTimeData.platform, 'X');
  t.truthy(result.realTimeData.trending_topics, 'Should have trending topics');
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
        content: 'Based on live search results...'
      }
    }],
    citations: [
      'https://example.com/result1',
      'https://example.com/result2'
    ],
    usage: {
      prompt_tokens: 150,
      completion_tokens: 200,
      total_tokens: 350,
      num_sources_used: 5
    }
  };

  const result = plugin.parseResponse(mockResponse);
  
  // Verify response content and citations
  t.is(result.output_text, 'Based on live search results...');
  t.truthy(result.citations, 'Should have citations');
  t.is(result.citations.length, 2, 'Should have 2 citations');
  t.is(result.citations[0].url, 'https://example.com/result1');
  t.is(result.citations[1].url, 'https://example.com/result2');
  
  // Verify usage data is preserved
  t.truthy(mockResponse.usage, 'Usage data should be preserved in original response');
  t.is(mockResponse.usage.num_sources_used, 5, 'Should show 5 sources used');
});

test('should validate search parameters - valid parameters', t => {
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

  const validParams = {
    mode: 'auto',
    return_citations: true,
    from_date: '2024-01-01',
    to_date: '2024-12-31',
    max_search_results: 25,
    sources: [
      { type: 'web', country: 'US' },
      { type: 'x', included_x_handles: ['testuser'] },
      { type: 'news' },
      { type: 'rss', links: ['https://example.com/feed.xml'] }
    ]
  };

  t.true(plugin.validateSearchParameters(validParams));
});

test('should validate search parameters - invalid mode', t => {
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

  const invalidParams = {
    mode: 'invalid_mode'
  };

  const error = t.throws(() => plugin.validateSearchParameters(invalidParams));
  t.true(error.message.includes('Invalid \'mode\' parameter'));
});

test('should validate search parameters - invalid date format', t => {
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

  const invalidParams = {
    from_date: '2024/01/01' // Invalid format
  };

  const error = t.throws(() => plugin.validateSearchParameters(invalidParams));
  t.true(error.message.includes('must be in YYYY-MM-DD format'));
});

test('should validate search parameters - invalid max_search_results', t => {
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

  const invalidParams = {
    max_search_results: 100 // Too high
  };

  const error = t.throws(() => plugin.validateSearchParameters(invalidParams));
  t.true(error.message.includes('must be 50 or less'));
});

test('should validate search parameters - invalid X handles count', t => {
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

  const invalidParams = {
    sources: [{
      type: 'x',
      included_x_handles: Array(11).fill('user') // Too many handles
    }]
  };

  const error = t.throws(() => plugin.validateSearchParameters(invalidParams));
  t.true(error.message.includes('can have a maximum of 10 items'));
});

test('should validate search parameters - conflicting X handles', t => {
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

  const invalidParams = {
    sources: [{
      type: 'x',
      included_x_handles: ['user1'],
      excluded_x_handles: ['user2'] // Cannot specify both
    }]
  };

  const error = t.throws(() => plugin.validateSearchParameters(invalidParams));
  t.true(error.message.includes('cannot be specified simultaneously'));
});

test('should validate search parameters - invalid RSS links count', t => {
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

  const invalidParams = {
    sources: [{
      type: 'rss',
      links: ['https://feed1.xml', 'https://feed2.xml'] // Too many links
    }]
  };

  const error = t.throws(() => plugin.validateSearchParameters(invalidParams));
  t.true(error.message.includes('can only have one item'));
});

test('safeJsonParse should parse valid JSON', t => {
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

  const validJson = '{"key": "value", "number": 42}';
  const result = safeJsonParse(validJson);

  t.deepEqual(result, { key: 'value', number: 42 });
});

test('safeJsonParse should return original string for invalid JSON', t => {
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

  const invalidJson = '{"key": "value", "invalid": }';
  const result = safeJsonParse(invalidJson);

  t.is(result, invalidJson);
});

test('safeJsonParse should return non-string input as-is', t => {
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

  const objectInput = { key: 'value' };
  const result = safeJsonParse(objectInput);

  t.is(result, objectInput);
});

test('safeJsonParse should return null/undefined as-is', t => {
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

  t.is(safeJsonParse(null), null);
  t.is(safeJsonParse(undefined), undefined);
});
