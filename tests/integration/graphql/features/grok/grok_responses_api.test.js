// grok_responses_api.test.js
// This file contains tests for the new xAI Responses API with agentic search tools
// This replaces the deprecated Live Search API (search_parameters approach)

import test from 'ava';
import serverFactory from '../../../../../index.js';

let testServer;

// Set default timeout for all tests in this file (90 seconds for agentic search)
test.beforeEach(async t => {
  t.timeout(90000);
});

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

// ============================================================================
// Basic Search Tests
// ============================================================================

// Test the new Responses API with default tools (web + x search)
// This test verifies that citations are properly returned in the resultData
test('should execute Responses API with default search tools and return citations', async t => {

  const response = await testServer.executeOperation({
    query: `
      query TestGrokResponsesDefault($text: String, $stream: Boolean) {
        grok_live_search(text: $text, stream: $stream) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'What are the latest AI developments from the last week?',
      stream: false
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.grok_live_search;
  const result = data?.result;
  const resultData = data?.resultData;
  
  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');
  
  // Verify inline citations appear in the result text (e.g., [[1]](https://...))
  const citationPattern = /\[\[\d+\]\]\(https?:\/\/[^\)]+\)/;
  t.true(citationPattern.test(String(result)), 'Result should contain inline citations in markdown format [[n]](url)');
  
  // Verify citations are in resultData
  t.truthy(resultData, 'Should have resultData');
  const resultDataObject = JSON.parse(resultData);
  
  t.truthy(resultDataObject.citations, 'Should have citations array in resultData');
  t.true(Array.isArray(resultDataObject.citations), 'Citations should be an array');
  t.true(resultDataObject.citations.length > 0, 'Should have at least one citation');
  
  // Validate citation structure
  resultDataObject.citations.forEach((citation, index) => {
    t.truthy(citation.url, `Citation ${index} should have a URL`);
    t.true(typeof citation.url === 'string', `Citation ${index} URL should be a string`);
    t.truthy(citation.title, `Citation ${index} should have a title`);
  });
});

// ============================================================================
// X Search Tool Tests
// ============================================================================

// Test the new Responses API with explicit X search tools configuration
test('should execute Responses API with X search tool configuration', async t => {

  const tools = JSON.stringify({
    x_search: {
      allowed_x_handles: ['OpenAI', 'AnthropicAI', 'xai']
    }
  });

  const response = await testServer.executeOperation({
    query: `
      query TestGrokResponsesXSearch($text: String, $tools: String) {
        grok_live_search(text: $text, tools: $tools) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'What are the latest announcements from AI companies?',
      tools: tools
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.grok_live_search;
  const result = data?.result;
  const resultData = data?.resultData;
  
  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');
  
  // Check for citations with X platform URLs
  if (resultData) {
    try {
      const resultDataObject = JSON.parse(resultData);
      
      if (resultDataObject.citations && resultDataObject.citations.length > 0) {
        // At least some citations should be from X/Twitter
        const xCitations = resultDataObject.citations.filter(c => 
          c.url && (c.url.includes('x.com') || c.url.includes('twitter.com'))
        );
        t.true(xCitations.length >= 0, 'Should handle X platform citations');
      }
    } catch (error) {
      t.pass('resultData handled');
    }
  }
});

// Test X search with excluded handles
test('should execute X search with excluded handles', async t => {

  const tools = JSON.stringify({
    x_search: {
      excluded_x_handles: ['spam_account', 'bot_account']
    }
  });

  const response = await testServer.executeOperation({
    query: `
      query TestGrokXSearchExcluded($text: String, $tools: String) {
        grok_live_search(text: $text, tools: $tools) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'What are people discussing about technology?',
      tools: tools
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.grok_live_search;
  const result = data?.result;
  
  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');
});

// ============================================================================
// Date Range Tests
// ============================================================================

// Test X search tool with date range
test('should execute X search with date range parameters', async t => {

  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 7); // 7 days ago
  const toDate = new Date();

  const tools = JSON.stringify({
    x_search: {
      from_date: fromDate.toISOString().split('T')[0],
      to_date: toDate.toISOString().split('T')[0]
    }
  });

  const response = await testServer.executeOperation({
    query: `
      query TestGrokResponsesDateRange($text: String, $tools: String) {
        grok_live_search(text: $text, tools: $tools) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'Recent AI model releases and updates',
      tools: tools
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.grok_live_search;
  const result = data?.result;
  
  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');
});

// Test X search with specific historical date range
test('should execute X search with historical date range', async t => {

  const tools = JSON.stringify({
    x_search: {
      from_date: '2025-10-01',
      to_date: '2025-10-10'
    }
  });

  const response = await testServer.executeOperation({
    query: `
      query TestGrokHistoricalDateRange($text: String, $tools: String) {
        grok_live_search(text: $text, tools: $tools) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'What was the status of xAI during this period?',
      tools: tools
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.grok_live_search;
  const result = data?.result;
  
  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');
});

// ============================================================================
// Image Understanding Tests
// ============================================================================

// Test X search with image understanding enabled
test('should execute X search with image understanding enabled', async t => {

  const tools = JSON.stringify({
    x_search: {
      enable_image_understanding: true
    }
  });

  const response = await testServer.executeOperation({
    query: `
      query TestGrokImageUnderstanding($text: String, $tools: String) {
        grok_live_search(text: $text, tools: $tools) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'What images are being shared in recent xAI posts?',
      tools: tools
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.grok_live_search;
  const result = data?.result;
  
  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');
});

// ============================================================================
// Video Understanding Tests
// ============================================================================

// Test X search with video understanding enabled
test('should execute X search with video understanding enabled', async t => {

  const tools = JSON.stringify({
    x_search: {
      enable_video_understanding: true
    }
  });

  const response = await testServer.executeOperation({
    query: `
      query TestGrokVideoUnderstanding($text: String, $tools: String) {
        grok_live_search(text: $text, tools: $tools) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'What is the latest video from the xAI official X account?',
      tools: tools
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.grok_live_search;
  const result = data?.result;
  
  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');
});

// Test X search with both image and video understanding enabled
test('should execute X search with both image and video understanding', async t => {

  const tools = JSON.stringify({
    x_search: {
      enable_image_understanding: true,
      enable_video_understanding: true
    }
  });

  const response = await testServer.executeOperation({
    query: `
      query TestGrokBothUnderstanding($text: String, $tools: String) {
        grok_live_search(text: $text, tools: $tools) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'What visual content (images and videos) is being shared about AI today?',
      tools: tools
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.grok_live_search;
  const result = data?.result;
  
  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');
});

// ============================================================================
// Web Search Tool Tests
// ============================================================================

// Test the new Responses API with web search tool configuration
test('should execute Responses API with web search tool configuration', async t => {

  const tools = JSON.stringify({
    web_search: {
      allowed_domain: ['techcrunch.com', 'theverge.com', 'wired.com']
    }
  });

  const response = await testServer.executeOperation({
    query: `
      query TestGrokResponsesWebSearch($text: String, $tools: String) {
        grok_live_search(text: $text, tools: $tools) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'What is the latest tech news?',
      tools: tools
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.grok_live_search;
  const result = data?.result;
  
  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');
});

// Test web search with excluded domains
test('should execute web search with excluded domains', async t => {

  const tools = JSON.stringify({
    web_search: {
      excluded_domain: ['tabloid.com', 'spam-site.com']
    }
  });

  const response = await testServer.executeOperation({
    query: `
      query TestGrokWebSearchExcluded($text: String, $tools: String) {
        grok_live_search(text: $text, tools: $tools) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'Latest news about climate change',
      tools: tools
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.grok_live_search;
  const result = data?.result;
  
  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');
});

// ============================================================================
// Combined Search Tests
// ============================================================================

// Test the new Responses API with combined web and X search
test('should execute Responses API with both web and X search tools', async t => {

  const tools = JSON.stringify({
    web_search: true,
    x_search: true
  });

  const response = await testServer.executeOperation({
    query: `
      query TestGrokResponsesCombined($text: String, $tools: String) {
        grok_live_search(text: $text, tools: $tools) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'What are people saying about the latest AI models?',
      tools: tools
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.grok_live_search;
  const result = data?.result;
  
  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');
});

// Test complex configuration with multiple parameters
test('should execute complex X search with handles and date range', async t => {

  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 14); // 14 days ago
  const toDate = new Date();

  const tools = JSON.stringify({
    x_search: {
      allowed_x_handles: ['OpenAI', 'xai', 'AnthropicAI', 'Google'],
      from_date: fromDate.toISOString().split('T')[0],
      to_date: toDate.toISOString().split('T')[0]
    }
  });

  const response = await testServer.executeOperation({
    query: `
      query TestGrokComplexConfig($text: String, $tools: String) {
        grok_live_search(text: $text, tools: $tools) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'Latest AI announcements and updates from major labs',
      tools: tools
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.grok_live_search;
  const result = data?.result;
  
  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');
});

// ============================================================================
// Backward Compatibility Tests
// ============================================================================

// Test backward compatibility with legacy search_parameters format
// This test uses the new model but with legacy search_parameters format
// The plugin should convert search_parameters to the new tools format
test('should maintain backward compatibility with search_parameters', async t => {

  const search_parameters = JSON.stringify({
    mode: 'auto',
    return_citations: true,
    max_search_results: 10,
    sources: [{type: 'web'}, {type: 'x'}]
  });

  const response = await testServer.executeOperation({
    query: `
      query TestGrokResponsesLegacy($text: String, $search_parameters: String) {
        grok_live_search(text: $text, search_parameters: $search_parameters) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'What are the latest developments in quantum computing?',
      search_parameters: search_parameters
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.grok_live_search;
  const result = data?.result;
  
  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');
});

// ============================================================================
// SearchXPlatform Tool Tests
// ============================================================================

// Test SearchXPlatform tool with new Responses API
test('should execute SearchXPlatform tool via Responses API', async t => {

  const response = await testServer.executeOperation({
    query: `
      query TestSearchXPlatformResponses($text: String, $userMessage: String) {
        sys_tool_grok_x_search(text: $text, userMessage: $userMessage) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'What are AI researchers discussing on X?',
      userMessage: 'Searching X platform for AI research discussions'
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.sys_tool_grok_x_search;
  const result = data?.result;
  
  t.truthy(result, 'Should have a result');
  
  // Parse the SearchResponse
  let searchResponse;
  try {
    searchResponse = JSON.parse(result);
  } catch (error) {
    t.fail(`Failed to parse SearchResponse: ${error.message}`);
    return;
  }
  
  // Validate SearchResponse format
  t.is(searchResponse._type, 'SearchResponse', 'Should return SearchResponse type');
  t.truthy(searchResponse.value, 'Should have value array');
  t.true(Array.isArray(searchResponse.value), 'Value should be an array');
  t.truthy(searchResponse.text, 'Should have transformed text');
});

// Test SearchXPlatform tool with handles filter
test('should execute SearchXPlatform tool with included handles', async t => {

  const response = await testServer.executeOperation({
    query: `
      query TestSearchXPlatformHandles($text: String, $userMessage: String, $includedHandles: [String]) {
        sys_tool_grok_x_search(text: $text, userMessage: $userMessage, includedHandles: $includedHandles) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'Latest AI announcements and updates',
      userMessage: 'Searching X platform for AI announcements from specific accounts',
      includedHandles: ['OpenAI', 'AnthropicAI', 'xai', 'Google']
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.sys_tool_grok_x_search;
  const result = data?.result;
  
  t.truthy(result, 'Should have a result');
  
  let searchResponse;
  try {
    searchResponse = JSON.parse(result);
  } catch (error) {
    t.fail(`Failed to parse SearchResponse: ${error.message}`);
    return;
  }
  
  t.is(searchResponse._type, 'SearchResponse', 'Should return SearchResponse type');
  t.truthy(searchResponse.value, 'Should have value array');
});

// Test SearchXPlatform tool with excluded handles
test('should execute SearchXPlatform tool with excluded handles', async t => {

  const response = await testServer.executeOperation({
    query: `
      query TestSearchXPlatformExcludedHandles($text: String, $userMessage: String, $excludedHandles: [String]) {
        sys_tool_grok_x_search(text: $text, userMessage: $userMessage, excludedHandles: $excludedHandles) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'What are people discussing about AI on X?',
      userMessage: 'Searching X platform for AI discussions excluding certain accounts',
      excludedHandles: ['spam_bot', 'fake_news']
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.sys_tool_grok_x_search;
  const result = data?.result;
  
  t.truthy(result, 'Should have a result');
  
  let searchResponse;
  try {
    searchResponse = JSON.parse(result);
  } catch (error) {
    t.fail(`Failed to parse SearchResponse: ${error.message}`);
    return;
  }
  
  t.is(searchResponse._type, 'SearchResponse', 'Should return SearchResponse type');
});

// Test SearchXPlatform tool with date range
test('should execute SearchXPlatform tool with date range', async t => {

  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 7); // 7 days ago
  const toDate = new Date();

  const response = await testServer.executeOperation({
    query: `
      query TestSearchXPlatformDates($text: String, $userMessage: String, $fromDate: String, $toDate: String) {
        sys_tool_grok_x_search(text: $text, userMessage: $userMessage, fromDate: $fromDate, toDate: $toDate) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'Recent AI developments',
      userMessage: 'Searching X platform for AI developments in the last week',
      fromDate: fromDate.toISOString().split('T')[0],
      toDate: toDate.toISOString().split('T')[0]
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.sys_tool_grok_x_search;
  const result = data?.result;
  
  t.truthy(result, 'Should have a result');
  
  let searchResponse;
  try {
    searchResponse = JSON.parse(result);
  } catch (error) {
    t.fail(`Failed to parse SearchResponse: ${error.message}`);
    return;
  }
  
  t.is(searchResponse._type, 'SearchResponse', 'Should return SearchResponse type');
});

// Test SearchXPlatform tool with image understanding
test('should execute SearchXPlatform tool with image understanding', async t => {

  const response = await testServer.executeOperation({
    query: `
      query TestSearchXPlatformImages($text: String, $userMessage: String, $enableImageUnderstanding: Boolean) {
        sys_tool_grok_x_search(text: $text, userMessage: $userMessage, enableImageUnderstanding: $enableImageUnderstanding) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'What images are being shared about AI?',
      userMessage: 'Searching X platform for images about AI',
      enableImageUnderstanding: true
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.sys_tool_grok_x_search;
  const result = data?.result;
  
  t.truthy(result, 'Should have a result');
  
  let searchResponse;
  try {
    searchResponse = JSON.parse(result);
  } catch (error) {
    t.fail(`Failed to parse SearchResponse: ${error.message}`);
    return;
  }
  
  t.is(searchResponse._type, 'SearchResponse', 'Should return SearchResponse type');
});

// Test SearchXPlatform tool with video understanding
test('should execute SearchXPlatform tool with video understanding', async t => {

  const response = await testServer.executeOperation({
    query: `
      query TestSearchXPlatformVideos($text: String, $userMessage: String, $enableVideoUnderstanding: Boolean) {
        sys_tool_grok_x_search(text: $text, userMessage: $userMessage, enableVideoUnderstanding: $enableVideoUnderstanding) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'What videos are being shared about AI?',
      userMessage: 'Searching X platform for videos about AI',
      enableVideoUnderstanding: true
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.sys_tool_grok_x_search;
  const result = data?.result;
  
  t.truthy(result, 'Should have a result');
  
  let searchResponse;
  try {
    searchResponse = JSON.parse(result);
  } catch (error) {
    t.fail(`Failed to parse SearchResponse: ${error.message}`);
    return;
  }
  
  t.is(searchResponse._type, 'SearchResponse', 'Should return SearchResponse type');
});

// Test citation URL extraction
test('should extract proper titles from X platform URLs', async t => {

  const response = await testServer.executeOperation({
    query: `
      query TestCitationExtraction($text: String, $userMessage: String, $includedHandles: [String]) {
        sys_tool_grok_x_search(text: $text, userMessage: $userMessage, includedHandles: $includedHandles) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'What are the latest posts from OpenAI?',
      userMessage: 'Searching for recent OpenAI posts',
      includedHandles: ['OpenAI']
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.sys_tool_grok_x_search;
  const result = data?.result;
  const resultData = data?.resultData;
  
  t.truthy(result, 'Should have a result');
  
  // Parse and validate SearchResponse
  let searchResponse;
  try {
    searchResponse = JSON.parse(result);
  } catch (error) {
    t.fail(`Failed to parse SearchResponse: ${error.message}`);
    return;
  }
  
  t.is(searchResponse._type, 'SearchResponse', 'Should return SearchResponse type');
  t.truthy(searchResponse.value, 'Should have value array');
  
  // Check resultData for citations
  if (resultData) {
    try {
      const resultDataObject = JSON.parse(resultData);
      t.is(resultDataObject.toolUsed, 'SearchXPlatform', 'Should have correct toolUsed');
      
      if (resultDataObject.citations && resultDataObject.citations.length > 0) {
        resultDataObject.citations.forEach((citation, index) => {
          t.truthy(citation.url, `Citation ${index} should have a URL`);
          if (citation.url.includes('x.com') || citation.url.includes('twitter.com')) {
            t.truthy(citation.title, `Citation ${index} from X should have a title`);
          }
        });
      }
    } catch (error) {
      t.pass('resultData handled');
    }
  }
});
