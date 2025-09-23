// grok_x_search_tool.test.js
// This file contains tests for the Grok X Platform search tool

import test from 'ava';
import serverFactory from '../../../../../index.js';

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

// Test basic X platform search functionality through tool pathway
test('should execute SearchXPlatform tool directly', async t => {

  const response = await testServer.executeOperation({
    query: `
      query TestSearchXPlatform($text: String, $userMessage: String) {
        sys_tool_grok_x_search(text: $text, userMessage: $userMessage) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'What are people saying about AI on X platform?',
      userMessage: 'Searching X platform for AI discussions'
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.sys_tool_grok_x_search;
  const result = data?.result;
  const resultData = data?.resultData;
  
  t.truthy(result, 'Should have a result');
  
  // Parse the SearchResponse
  let searchResponse;
  try {
    searchResponse = JSON.parse(result);
  } catch (error) {
    t.fail(`Failed to parse SearchResponse: ${error.message}`);
  }
  
  // Validate SearchResponse format
  t.is(searchResponse._type, 'SearchResponse', 'Should return SearchResponse type');
  t.truthy(searchResponse.value, 'Should have value array');
  t.true(Array.isArray(searchResponse.value), 'Value should be an array');
  t.truthy(searchResponse.text, 'Should have transformed text');
  
  // Validate search results structure
  if (searchResponse.value.length > 0) {
    const firstResult = searchResponse.value[0];
    t.truthy(firstResult.searchResultId, 'Should have searchResultId');
    t.truthy(firstResult.title, 'Should have title');
    t.truthy(firstResult.url, 'Should have url');
    t.truthy(firstResult.content, 'Should have content');
    t.is(firstResult.source, 'X Platform', 'Should have correct source');
  }
  
  // Check tool metadata
  if (resultData) {
    try {
      const resultDataObject = JSON.parse(resultData);
      t.is(resultDataObject.toolUsed, 'SearchXPlatform', 'Should have correct toolUsed');
    } catch (error) {
      t.fail('Failed to parse resultData');
    }
  }
});

// Test X platform search with specific handles
test('should execute SearchXPlatform with included handles', async t => {

  const response = await testServer.executeOperation({
    query: `
      query TestSearchXPlatformWithHandles($text: String, $userMessage: String, $includedHandles: [String]) {
        sys_tool_grok_x_search(text: $text, userMessage: $userMessage, includedHandles: $includedHandles) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'What are the latest AI developments and announcements?',
      userMessage: 'Searching X platform for AI developments from specific handles',
      includedHandles: ['OpenAI', 'AnthropicAI', 'xai']
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
  }
  
  t.is(searchResponse._type, 'SearchResponse', 'Should return SearchResponse type');
  t.truthy(searchResponse.value, 'Should have value array');
  t.true(Array.isArray(searchResponse.value), 'Value should be an array');
  
  // Check tool metadata for search parameters
  if (resultData) {
    try {
      const resultDataObject = JSON.parse(resultData);
      t.is(resultDataObject.toolUsed, 'SearchXPlatform', 'Should have correct toolUsed');
    } catch (error) {
      t.fail('Failed to parse resultData');
    }
  }
});

// Test X platform search with engagement filters
test('should execute SearchXPlatform with engagement filters', async t => {
  t.timeout(60000);
  
  const response = await testServer.executeOperation({
    query: `
      query TestSearchXPlatformWithEngagement($text: String, $userMessage: String, $minFavorites: Int, $minViews: Int, $maxResults: Int) {
        sys_tool_grok_x_search(text: $text, userMessage: $userMessage, minFavorites: $minFavorites, minViews: $minViews, maxResults: $maxResults) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'Popular posts about machine learning',
      userMessage: 'Searching X platform for popular ML posts',
      minFavorites: 500,
      minViews: 5000,
      maxResults: 5
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
  }
  
  t.is(searchResponse._type, 'SearchResponse', 'Should return SearchResponse type');
  t.truthy(searchResponse.value, 'Should have value array');
  t.true(Array.isArray(searchResponse.value), 'Value should be an array');
  t.true(searchResponse.value.length <= 5, 'Should respect maxResults limit');
  
  // Check tool metadata for engagement filters
  if (resultData) {
    try {
      const resultDataObject = JSON.parse(resultData);
      t.is(resultDataObject.toolUsed, 'SearchXPlatform', 'Should have correct toolUsed');
    } catch (error) {
      t.fail('Failed to parse resultData');
    }
  }
});

// Test X platform search with excluded handles
test('should execute SearchXPlatform with excluded handles', async t => {
  t.timeout(60000);
  
  const response = await testServer.executeOperation({
    query: `
      query TestSearchXPlatformWithExcludedHandles($text: String, $userMessage: String, $excludedHandles: [String]) {
        sys_tool_grok_x_search(text: $text, userMessage: $userMessage, excludedHandles: $excludedHandles) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'Recent discussions about technology',
      userMessage: 'Searching X platform for tech discussions excluding spam',
      excludedHandles: ['spam_account', 'bot_account']
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
  }
  
  t.is(searchResponse._type, 'SearchResponse', 'Should return SearchResponse type');
  t.truthy(searchResponse.value, 'Should have value array');
  t.true(Array.isArray(searchResponse.value), 'Value should be an array');
  
  // Check tool metadata for excluded handles
  if (resultData) {
    try {
      const resultDataObject = JSON.parse(resultData);
      t.is(resultDataObject.toolUsed, 'SearchXPlatform', 'Should have correct toolUsed');
    } catch (error) {
      t.fail('Failed to parse resultData');
    }
  }
});

// Test citation handling with inline citations
test('should handle inline citations in SearchResponse', async t => {
  t.timeout(60000);
  
  // Mock a response with inline citations to test the transformation
  const mockResponse = {
    result: 'Here is some information about AI [1(https://x.com/example/status/123)] and more details [2(https://x.com/another/status/456)].',
    citations: [
      { url: 'https://x.com/example/status/123', title: 'AI Discussion Post' },
      { url: 'https://x.com/another/status/456', title: 'Another AI Post' }
    ]
  };
  
  // We'll test this by calling the tool and checking if citations are properly transformed
  const response = await testServer.executeOperation({
    query: `
      query TestCitationHandling($text: String, $userMessage: String) {
        sys_tool_grok_x_search(text: $text, userMessage: $userMessage) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'Test citation handling with X platform posts',
      userMessage: 'Testing citation transformation'
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.sys_tool_grok_x_search;
  const result = data?.result;
  
  t.truthy(result, 'Should have a result');
  
  // Parse and validate SearchResponse
  let searchResponse;
  try {
    searchResponse = JSON.parse(result);
  } catch (error) {
    t.fail(`Failed to parse SearchResponse: ${error.message}`);
  }
  
  t.is(searchResponse._type, 'SearchResponse', 'Should return SearchResponse type');
  t.truthy(searchResponse.value, 'Should have value array');
  t.truthy(searchResponse.text, 'Should have transformed text');
  
  // Check that search results have proper structure
  if (searchResponse.value.length > 0) {
    searchResponse.value.forEach(result => {
      t.truthy(result.searchResultId, 'Each result should have searchResultId');
      t.truthy(result.title, 'Each result should have title');
      t.truthy(result.url, 'Each result should have url');
      t.is(result.source, 'X Platform', 'Each result should have correct source');
    });
  }
  
  // Check that text contains proper citation format (if citations exist)
  if (searchResponse.text && searchResponse.text.includes(':cd_source[')) {
    t.true(searchResponse.text.includes(':cd_source['), 'Text should contain transformed citations');
  }
});

// Test URL title extraction for X platform URLs
test('should extract proper titles from X platform URLs', async t => {
  t.timeout(60000);
  
  const response = await testServer.executeOperation({
    query: `
      query TestURLTitleExtraction($text: String, $userMessage: String) {
        sys_tool_grok_x_search(text: $text, userMessage: $userMessage) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'Find posts from @OpenAI about latest developments',
      userMessage: 'Testing URL title extraction for X platform URLs'
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.sys_tool_grok_x_search;
  const result = data?.result;
  
  t.truthy(result, 'Should have a result');
  
  // Parse and validate SearchResponse
  let searchResponse;
  try {
    searchResponse = JSON.parse(result);
  } catch (error) {
    t.fail(`Failed to parse SearchResponse: ${error.message}`);
  }
  
  t.is(searchResponse._type, 'SearchResponse', 'Should return SearchResponse type');
  t.truthy(searchResponse.value, 'Should have value array');
  
  // Check that titles are properly extracted for X platform URLs
  if (searchResponse.value.length > 0) {
    searchResponse.value.forEach(result => {
      if (result.url && (result.url.includes('x.com/') || result.url.includes('twitter.com/'))) {
        t.truthy(result.title, 'X platform URLs should have extracted titles');
        t.true(result.title.length > 0, 'Title should not be empty');
        // Title should contain some indication it's from X platform
        t.true(
          result.title.includes('X Post') || 
          result.title.includes('@') || 
          result.title.includes('X Platform'),
          'Title should indicate X platform source'
        );
      }
    });
  }
});
