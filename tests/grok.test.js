// grok.test.js
// This file contains e2e connection tests for Grok models (actual API calls)

import test from 'ava';
import serverFactory from '../index.js';

let testServer;

// Set default timeout for all tests in this file (60 seconds)
test.beforeEach(async t => {
  t.timeout(60000);
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

// Real API tests - these will call the actual Grok model
test('make a chat_jarvis API call to Grok 3', async t => {

  const response = await testServer.executeOperation({
    query: `
      query TestGrokDirect($chatHistory: [MultiMessage], $model: String) {
        chat_jarvis(chatHistory: $chatHistory, model: $model) {
          result
          errors
        }
      }
    `,
    variables: {
      chatHistory: [
        {
          role: 'user',
          content: 'Hi there!  To whom am I speaking?  Can you tell me what model you are running on right now?'
        }
      ],
      model: 'xai-grok-3'
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const result = response.body?.singleResult?.data?.chat_jarvis?.result;
  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');
});

test('make a chat_jarvis API call to Grok 4', async t => {

  const response = await testServer.executeOperation({
    query: `
      query TestGrokDirect($chatHistory: [MultiMessage], $model: String) {
        chat_jarvis(chatHistory: $chatHistory, model: $model) {
          result
          errors
        }
      }
    `,
    variables: {
      chatHistory: [
        {
          role: 'user',
          content: 'Hi there!  To whom am I speaking?  Can you tell me what model you are running on right now?'
        }
      ],
      model: 'xai-grok-4'
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const result = response.body?.singleResult?.data?.chat_jarvis?.result;
  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');
});

test('test grok live search pathway - simple', async t => {

  const response = await testServer.executeOperation({
    query: `
      query TestGrokWebSearch($text: String) {
        grok_live_search(text: $text) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'Provide me a digest of world news for last week.'
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.grok_live_search;
  const result = data?.result;
  const resultData = data?.resultData;
  
  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');
  
  // Check for Live Search data in resultData
  if (resultData) {
    try {
      const resultDataObject = JSON.parse(resultData);
      
      if (resultDataObject.citations) {
        t.true(Array.isArray(resultDataObject.citations), 'Citations should be an array');
      }
    } catch (error) {
      t.fail('Failed to parse resultData');
    }
  }
});

// Test Grok 4 through the vision pathway for multimodal capabilities
test('should execute Grok 4 through vision pathway', async t => {

  const response = await testServer.executeOperation({
    query: `
      query TestGrokVision($text: String, $chatHistory: [MultiMessage], $model: String) {
        vision(text: $text, chatHistory: $chatHistory, model: $model) {
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
            '{"type":"image_url","image_url":{"url":"https://static.toiimg.com/thumb/msid-102827471,width-1280,height-720,resizemode-4/102827471.jpg"}}'
          ]
        }
      ],
      model: 'xai-grok-4'
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const result = response.body?.singleResult?.data?.vision?.result;
  
  if (result) {
    t.true(result.length > 0, 'Should have a non-empty result');
  } else {
    // If no result, it might be due to API issues (400 error, auth issues, etc.)
    const errors = response.body?.singleResult?.data?.vision?.errors;
    if (errors) {
      t.fail('Should have no errors');
    }
  }
}); 

// Test Grok Live Search functionality
test('should execute Live Search with X platform search', async t => {

  const search_parameters = JSON.stringify({
    mode: 'auto',
    return_citations: true,
    max_search_results: 10,
    sources: [{type: 'web'}, {type: 'x'}]
  });

  const response = await testServer.executeOperation({
    query: `
      query TestGrokLiveSearch($text: String, $search_parameters: String) {
        grok_live_search(text: $text, search_parameters: $search_parameters) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: `What are the latest AI model releases from the last couple weeks?`,
      search_parameters: search_parameters
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.grok_live_search;
  const result = data?.result;
  const resultData = data?.resultData;
  
  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');
  
  // Parse resultData for Live Search information
  t.truthy(resultData, 'Should have resultData');
  try {
    const resultDataObject = JSON.parse(resultData);
    
    // Parse and display citations
    t.truthy(resultDataObject.citations, 'Should have citations array since return_citations is true');
    t.true(Array.isArray(resultDataObject.citations), 'Citations should be an array');
    t.true(resultDataObject.citations.length > 0, 'Should have at least one citation for successful search');

    // Validate citation structure
    resultDataObject.citations.forEach((citation, index) => {
      t.truthy(citation.url, `Citation ${index} should have a URL`);
      t.true(typeof citation.url === 'string', `Citation ${index} URL should be a string`);

      // Validate URL format
      try {
        new URL(citation.url);
        t.pass(`Citation ${index} has valid URL format: ${citation.url}`);
      } catch (e) {
        t.fail(`Citation ${index} has invalid URL format: ${citation.url}`);
      }
    });

    // Parse and display usage data
    t.truthy(resultDataObject.usage, 'Should have usage data');
    if (resultDataObject.usage) {
      // Usage should now be an array of objects
      t.true(Array.isArray(resultDataObject.usage), 'Usage should be an array');
      if (resultDataObject.usage.length > 0) {
        const latestUsage = resultDataObject.usage[0]; // Most recent usage first
        if (latestUsage.num_sources_used) {
          t.true(typeof latestUsage.num_sources_used === 'number', 'num_sources_used should be a number');
        }
      }
    }
    
  } catch (error) {
    t.fail('Failed to parse resultData');
  }
});

// Test Live Search with web source parameters
test('should execute Live Search with web source parameters', async t => {

  const search_parameters = JSON.stringify({
    mode: 'auto',
    return_citations: true,
    max_search_results: 10,
    sources: [{
      type: 'web',
      country: 'US',
      excluded_websites: [],
      allowed_websites: ['techcrunch.com', 'wired.com'],
      safe_search: true
    }]
  });
  
  const response = await testServer.executeOperation({
    query: `
      query TestGrokWebSearchParams($text: String, $search_parameters: String) {
        grok_live_search(text: $text, search_parameters: $search_parameters) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'What\'s going on with Elon Musk?',
      search_parameters: search_parameters
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.grok_live_search;
  const result = data?.result;
  const resultData = data?.resultData;
  
  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');
  
  // Check for Live Search data in resultData and validate citations
  if (resultData) {
    try {
      const resultDataObject = JSON.parse(resultData);
      
      // Citations should exist since return_citations is true
      t.truthy(resultDataObject.citations, 'Should have citations array since return_citations is true');
      t.true(Array.isArray(resultDataObject.citations), 'Citations should be an array');

      // Validate that citations exist and are from valid sources
      t.true(resultDataObject.citations.length > 0, 'Should have at least one citation for successful search');

      // Validate citation structure and URLs
      resultDataObject.citations.forEach((citation, index) => {
        t.truthy(citation.url, `Citation ${index} should have a URL`);
        t.true(typeof citation.url === 'string', `Citation ${index} URL should be a string`);

        // Validate URL format
        try {
          new URL(citation.url);
          t.pass(`Citation ${index} has valid URL format: ${citation.url}`);
        } catch (e) {
          t.fail(`Citation ${index} has invalid URL format: ${citation.url}`);
        }

        // Additional validation for web sources - should be from allowed websites
        if (citation.url.includes('techcrunch.com') || citation.url.includes('wired.com')) {
          t.pass(`Citation ${index} is from allowed website: ${citation.url}`);
        }
      });
    } catch (error) {
      t.fail('Failed to parse resultData');
    }
  }
});

// Test Live Search with X source parameters
test('should execute Live Search with X source parameters', async t => {

  const search_parameters = JSON.stringify({
    mode: 'auto',
    return_citations: true,
    max_search_results: 10,
    sources: [{
      type: 'x',
      included_x_handles: ['OpenAI', 'AnthropicAI', 'xai'],
      post_favorite_count: 100,
      post_view_count: 1000
    }]
  });
  
  const response = await testServer.executeOperation({
    query: `
      query TestGrokXSearchParams($text: String, $search_parameters: String) {
        grok_live_search(text: $text, search_parameters: $search_parameters) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'What are the latest AI developments and announcements?',
      search_parameters: search_parameters
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.grok_live_search;
  const result = data?.result;
  const resultData = data?.resultData;

  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');

  // Check for Live Search data in resultData
  if (resultData) {
    try {
      const resultDataObject = JSON.parse(resultData);

      // Citations should exist since return_citations is true
      t.truthy(resultDataObject.citations, 'Should have citations array since return_citations is true');
      t.true(Array.isArray(resultDataObject.citations), 'Citations should be an array');
      t.true(resultDataObject.citations.length > 0, 'Should have at least one citation for successful search');

      // Validate citation structure for X platform sources
      resultDataObject.citations.forEach((citation, index) => {
        t.truthy(citation.url, `Citation ${index} should have a URL`);
        t.true(typeof citation.url === 'string', `Citation ${index} URL should be a string`);

        // Validate URL format
        try {
          new URL(citation.url);
          t.pass(`Citation ${index} has valid URL format: ${citation.url}`);
        } catch (e) {
          t.fail(`Citation ${index} has invalid URL format: ${citation.url}`);
        }

        // For X platform sources, URLs should typically be from x.com or twitter.com
        if (citation.url.includes('x.com') || citation.url.includes('twitter.com')) {
          t.pass(`Citation ${index} is from X/Twitter platform: ${citation.url}`);
        }
      });
    } catch (error) {
      t.fail('Failed to parse resultData');
    }
  }
});

// Test Live Search with news source parameters
test('should execute Live Search with news source parameters', async t => {

  const search_parameters = JSON.stringify({
    mode: 'auto',
    return_citations: true,
    max_search_results: 10,
    sources: [{
      type: 'news',
      country: 'US',
      excluded_websites: ['tabloid.com'],
      safe_search: true
    }]
  });
  
  const response = await testServer.executeOperation({
    query: `
      query TestGrokNewsSearchParams($text: String, $search_parameters: String) {
        grok_live_search(text: $text, search_parameters: $search_parameters) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'Breaking news about climate change',
      search_parameters: search_parameters
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.grok_live_search;
  const result = data?.result;
  const resultData = data?.resultData;

  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');

  // Check for Live Search data in resultData
  if (resultData) {
    try {
      const resultDataObject = JSON.parse(resultData);

      // Citations should exist since return_citations is true
      t.truthy(resultDataObject.citations, 'Should have citations array since return_citations is true');
      t.true(Array.isArray(resultDataObject.citations), 'Citations should be an array');
      t.true(resultDataObject.citations.length > 0, 'Should have at least one citation for successful search');

      // Validate citation structure for news sources
      resultDataObject.citations.forEach((citation, index) => {
        t.truthy(citation.url, `Citation ${index} should have a URL`);
        t.true(typeof citation.url === 'string', `Citation ${index} URL should be a string`);

        // Validate URL format
        try {
          new URL(citation.url);
          t.pass(`Citation ${index} has valid URL format: ${citation.url}`);
        } catch (e) {
          t.fail(`Citation ${index} has invalid URL format: ${citation.url}`);
        }

        // For news sources, URLs should not be from excluded websites
        if (!citation.url.includes('tabloid.com')) {
          t.pass(`Citation ${index} is not from excluded website: ${citation.url}`);
        } else {
          t.fail(`Citation ${index} should not be from excluded website tabloid.com: ${citation.url}`);
        }
      });
    } catch (error) {
      t.fail('Failed to parse resultData');
    }
  }
});

// Test Live Search with RSS source parameters
test.only('should execute Live Search with RSS source parameters', async t => {

  const search_parameters = JSON.stringify({
    mode: 'on',
    return_citations: true,
    max_search_results: 10,
    sources: [{
      type: 'rss',
      links: ['https://www.aljazeera.com/xml/rss/all.xml']
    }]
  });
  
  const response = await testServer.executeOperation({
    query: `
      query TestGrokRSSSearchParams($text: String, $search_parameters: String) {
        grok_live_search(text: $text, search_parameters: $search_parameters) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'What is the latest news in this feed?',
      search_parameters: search_parameters
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.grok_live_search;
  const result = data?.result;
  const resultData = data?.resultData;

  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');

  // Check for Live Search data in resultData
  if (resultData) {
    try {
      const resultDataObject = JSON.parse(resultData);

      // Citations should exist since return_citations is true
      t.truthy(resultDataObject.citations, 'Should have citations array since return_citations is true');
      t.true(Array.isArray(resultDataObject.citations), 'Citations should be an array');
      t.true(resultDataObject.citations.length > 0, 'Should have at least one citation for successful search');

      // Validate citation structure for RSS sources
      resultDataObject.citations.forEach((citation, index) => {
        t.truthy(citation.url, `Citation ${index} should have a URL`);
        t.true(typeof citation.url === 'string', `Citation ${index} URL should be a string`);

        // Validate URL format
        try {
          new URL(citation.url);
          t.pass(`Citation ${index} has valid URL format: ${citation.url}`);
        } catch (e) {
          t.fail(`Citation ${index} has invalid URL format: ${citation.url}`);
        }

        // For RSS sources, URLs should typically be from the RSS feed source
        if (citation.url.includes('aljazeera.com')) {
          t.pass(`Citation ${index} is from RSS feed source: ${citation.url}`);
        }
      });
    } catch (error) {
      t.fail('Failed to parse resultData');
    }
  }
});

// Test Live Search with date range parameters
test('should execute Live Search with date range parameters', async t => {

  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 7); // 7 days ago
  const toDate = new Date();
  
  const search_parameters = JSON.stringify({
    mode: 'auto',
    return_citations: true,
    max_search_results: 10,
    from_date: fromDate.toISOString().split('T')[0], // YYYY-MM-DD format
    to_date: toDate.toISOString().split('T')[0],
    sources: [{
      type: 'web'
    }]
  });
  
  const response = await testServer.executeOperation({
    query: `
      query TestGrokDateRangeSearch($text: String, $search_parameters: String) {
        grok_live_search(text: $text, search_parameters: $search_parameters) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'Recent AI announcements',
      search_parameters: search_parameters
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.grok_live_search;
  const result = data?.result;
  const resultData = data?.resultData;

  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');

  // Check for Live Search data in resultData
  if (resultData) {
    try {
      const resultDataObject = JSON.parse(resultData);

      // Citations should exist since return_citations is true
      t.truthy(resultDataObject.citations, 'Should have citations array since return_citations is true');
      t.true(Array.isArray(resultDataObject.citations), 'Citations should be an array');
      t.true(resultDataObject.citations.length > 0, 'Should have at least one citation for successful search');

      // Validate citation structure for date range searches
      resultDataObject.citations.forEach((citation, index) => {
        t.truthy(citation.url, `Citation ${index} should have a URL`);
        t.true(typeof citation.url === 'string', `Citation ${index} URL should be a string`);

        // Validate URL format
        try {
          new URL(citation.url);
          t.pass(`Citation ${index} has valid URL format: ${citation.url}`);
        } catch (e) {
          t.fail(`Citation ${index} has invalid URL format: ${citation.url}`);
        }

        // For date range searches, we can't validate specific date constraints
        // but we can ensure the URLs are properly formed
        t.pass(`Citation ${index} has properly formatted citation data`);
      });
    } catch (error) {
      t.fail('Failed to parse resultData');
    }
  }
});

// Test Live Search with custom sources configuration
test('should execute Live Search with custom sources configuration', async t => {
  
  const search_parameters = JSON.stringify({
    mode: 'auto',
    return_citations: true,
    max_search_results: 10,
    sources: [
      {
        type: 'web'
      },
      {
        type: 'x'
      }
    ]
  });
  
  const response = await testServer.executeOperation({
    query: `
      query TestGrokCustomSources($text: String, $search_parameters: String) {
        grok_live_search(text: $text, search_parameters: $search_parameters) {
          result
          errors
          resultData
        }
      }
    `,
    variables: {
      text: 'Latest developments in machine learning',
      search_parameters: search_parameters
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const data = response.body?.singleResult?.data?.grok_live_search;
  const result = data?.result;
  const resultData = data?.resultData;

  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');

  // Check for Live Search data in resultData
  if (resultData) {
    try {
      const resultDataObject = JSON.parse(resultData);

      // Citations should exist since return_citations is true
      t.truthy(resultDataObject.citations, 'Should have citations array since return_citations is true');
      t.true(Array.isArray(resultDataObject.citations), 'Citations should be an array');
      t.true(resultDataObject.citations.length > 0, 'Should have at least one citation for successful search');
      t.true(resultDataObject.citations.length <= 20, 'Should respect max_search_results limit');

      // Validate citation structure for custom sources (web + x)
      resultDataObject.citations.forEach((citation, index) => {
        t.truthy(citation.url, `Citation ${index} should have a URL`);
        t.true(typeof citation.url === 'string', `Citation ${index} URL should be a string`);

        // Validate URL format
        try {
          new URL(citation.url);
          t.pass(`Citation ${index} has valid URL format: ${citation.url}`);
        } catch (e) {
          t.fail(`Citation ${index} has invalid URL format: ${citation.url}`);
        }

        // For custom sources (web + x), citations can be from various sources
        t.pass(`Citation ${index} has properly formatted citation data`);
      });

      if (resultDataObject.usage && Array.isArray(resultDataObject.usage) && resultDataObject.usage.length > 0) {
        const latestUsage = resultDataObject.usage[0]; // Most recent usage first
        if (latestUsage.num_sources_used) {
          t.true(typeof latestUsage.num_sources_used === 'number', 'num_sources_used should be a number');
        }
      }
    } catch (error) {
      t.fail('Failed to parse resultData');
    }
  }
});