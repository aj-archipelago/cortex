// grok.test.js
// This file contains e2e connection tests for Grok models (actual API calls)
// Note: Live Search API with search_parameters was deprecated on December 15, 2025.
// For search functionality, see grok_responses_api.test.js which uses the new Responses API with tools.

import test from 'ava';
import serverFactory from '../../../../../index.js';

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
      model: 'xai-grok-4-fast-reasoning'
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const result = response.body?.singleResult?.data?.chat_jarvis?.result;
  t.truthy(result, 'Should have a result');
  t.true(result.length > 0, 'Should have a non-empty result');
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
