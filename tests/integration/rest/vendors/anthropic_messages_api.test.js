/**
 * E2E integration tests for Anthropic Messages API compatibility
 *
 * Run with: npm test -- tests/integration/rest/vendors/anthropic_messages_api.test.js
 */
import test from 'ava';
import serverFactory from '../../../../index.js';
import got from 'got';
import { collectAnthropicSSE } from '../../../helpers/anthropicSseClient.js';

let testServer;
let testPort;

test.before(async () => {
  process.env.CORTEX_ENABLE_REST = 'true';
  testPort = String(4100 + Math.floor(Math.random() * 4000));
  process.env.CORTEX_PORT = testPort;
  const { server, startServer } = await serverFactory();
  startServer && await startServer();
  testServer = server;
});

test.after.always('cleanup', async () => {
  if (testServer) await testServer.stop();
});

test('Anthropic Messages API non-streaming response shape', async (t) => {
  const baseUrl = `http://localhost:${testPort}/v1`;
  const model = 'claude-45-sonnet';

  try {
    const res = await got(`${baseUrl}/models`, { responseType: 'json' });
    const ids = (res.body?.data || []).map(m => m.id);
    if (!ids.includes(model)) {
      t.pass(`Skipping - model ${model} not configured`);
      return;
    }
  } catch (err) {
    t.fail(`Failed to get models: ${err.message}`);
    return;
  }

  const payload = {
    model,
    system: 'You are a helpful assistant.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Say hello in one short sentence.' }] }
    ],
    tools: [
      {
        name: 'noop_tool',
        description: 'No-op tool for testing',
        input_schema: { type: 'object', properties: {} }
      }
    ],
    tool_choice: { type: 'auto' },
    max_tokens: 32
  };

  const response = await got.post(`${baseUrl}/messages`, {
    json: payload,
    responseType: 'json',
    timeout: { request: 60000 }
  });

  t.truthy(response.body, 'Should have response body');
  t.is(response.body.type, 'message');
  t.is(response.body.role, 'assistant');
  t.true(Array.isArray(response.body.content), 'Content should be an array');
  t.truthy(response.body.content[0], 'Should have at least one content block');
});

test('Anthropic Messages API streaming emits message_start and message_stop', async (t) => {
  const baseUrl = `http://localhost:${testPort}/v1`;
  const model = 'claude-45-sonnet';

  try {
    const res = await got(`${baseUrl}/models`, { responseType: 'json' });
    const ids = (res.body?.data || []).map(m => m.id);
    if (!ids.includes(model)) {
      t.pass(`Skipping - model ${model} not configured`);
      return;
    }
  } catch (err) {
    t.fail(`Failed to get models: ${err.message}`);
    return;
  }

  const payload = {
    model,
    system: 'You are a helpful assistant.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Reply with a short greeting.' }] }
    ],
    stream: true,
    max_tokens: 64
  };

  const events = await collectAnthropicSSE(baseUrl, '/messages', payload);
  t.true(events.length > 0, 'Should receive SSE events');
  t.true(events.some(e => e.event === 'message_start'), 'Should include message_start');
  t.true(events.some(e => e.event === 'message_stop'), 'Should include message_stop');
  t.true(events.some(e => e.event === 'message_delta' && e.data?.usage), 'Should include usage in message_delta');
});

test('Anthropic Messages API web_search_20250305 server-side tool streaming', async (t) => {
  const baseUrl = `http://localhost:${testPort}/v1`;
  const candidateModels = ['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6'];
  let model;

  // Check if model is available
  try {
    const res = await got(`${baseUrl}/models`, { responseType: 'json' });
    const ids = (res.body?.data || []).map(m => m.id);
    model = candidateModels.find(id => ids.includes(id));
    if (!model) {
      t.pass(`Skipping - none of the candidate models are configured: ${candidateModels.join(', ')}`);
      return;
    }
  } catch (err) {
    t.fail(`Failed to get models: ${err.message}`);
    return;
  }

  const payload = {
    model,
    system: 'You are a helpful assistant with web search capabilities.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'What is the current weather in Tokyo? Use web search to find out.' }] }
    ],
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 3
      }
    ],
    stream: true,
    max_tokens: 1024
  };

  // Web search can take longer, use 120s timeout
  const events = await collectAnthropicSSE(baseUrl, '/messages', payload, 120000);

  // Basic streaming structure
  t.true(events.length > 0, 'Should receive SSE events');
  t.true(events.some(e => e.event === 'message_start'), 'Should include message_start');
  t.true(events.some(e => e.event === 'message_stop'), 'Should include message_stop');

  // Check for server-side tool content blocks
  const contentBlockStarts = events.filter(e => e.event === 'content_block_start');
  const serverToolUseStart = contentBlockStarts.find(e => e.data?.content_block?.type === 'server_tool_use');
  const webSearchResultStart = contentBlockStarts.find(e => e.data?.content_block?.type === 'web_search_tool_result');

  // Log summary for debugging FIRST so we can see what happened on failure
  const blockTypes = contentBlockStarts.map(e => e.data?.content_block?.type).join(', ') || '(none)';
  console.log(`\n  Content blocks received: ${blockTypes}`);

  // CRITICAL: These assertions must NOT have fallback logic that allows text-only responses.
  // If web search isn't working, the test MUST fail - not silently accept a text response.

  // Verify server_tool_use block was received
  t.truthy(serverToolUseStart,
    `REQUIRED: server_tool_use block must be present. Got blocks: [${blockTypes}]. ` +
    'If this fails, web search tool is not being passed through to Vertex AI correctly.');

  // Verify server_tool_use has correct structure
  t.truthy(serverToolUseStart.data.content_block.id, 'server_tool_use should have an id');
  t.is(serverToolUseStart.data.content_block.name, 'web_search', 'server_tool_use should have name web_search');
  console.log(`  ✓ server_tool_use: id=${serverToolUseStart.data.content_block.id}, name=${serverToolUseStart.data.content_block.name}`);

  // CRITICAL: Verify server_tool_use input_json_delta events are passed through correctly
  // This was a bug where input_json_delta for server_tool_use was being converted to OpenAI tool_call format
  // instead of being passed through as Anthropic format
  const serverToolUseIndex = serverToolUseStart.data.index;
  const serverToolDeltas = events.filter(e =>
    e.event === 'content_block_delta' &&
    e.data?.index === serverToolUseIndex &&
    e.data?.delta?.type === 'input_json_delta'
  );
  t.true(serverToolDeltas.length > 0,
    `REQUIRED: server_tool_use should have input_json_delta events streamed. Got ${serverToolDeltas.length} deltas. ` +
    'If this fails, the server_tool_use query is not being streamed correctly to the client.');
  console.log(`  ✓ server_tool_use input_json_delta events: ${serverToolDeltas.length}`);

  // Verify web_search_tool_result block was received
  t.truthy(webSearchResultStart,
    `REQUIRED: web_search_tool_result block must be present. Got blocks: [${blockTypes}]. ` +
    'If server_tool_use exists but this is missing, Vertex AI returned an error.');

  // Verify web_search_tool_result has correct structure and actual results
  t.truthy(webSearchResultStart.data.content_block.tool_use_id, 'web_search_tool_result should have tool_use_id');
  const searchResults = webSearchResultStart.data.content_block.content || [];
  const resultCount = searchResults.length;
  console.log(`  ✓ web_search_tool_result: tool_use_id=${webSearchResultStart.data.content_block.tool_use_id}, results=${resultCount}`);

  // Validate that actual search results were returned (not 0 searches)
  t.true(resultCount > 0,
    `REQUIRED: web_search_tool_result must contain search results, got ${resultCount}. ` +
    'If this fails, the web search tool was called but returned no results.');

  // Check that results have expected structure (title, url, snippet/content)
  const firstResult = searchResults[0];
  if (firstResult && firstResult.type === 'web_search_result') {
    t.truthy(firstResult.url, 'Search result should have a URL');
    t.truthy(firstResult.title || firstResult.snippet || firstResult.content,
      'Search result should have title, snippet, or content');
    console.log(`    First result: "${firstResult.title}" - ${firstResult.url}`);
  }

  // Also verify we got a text response using the search results
  const hasTextBlock = contentBlockStarts.some(e => e.data?.content_block?.type === 'text');

  // Verify the model produced a text response using the search results
  t.true(hasTextBlock, 'Model should produce a text response after searching');

  // Check that the text response contains actual content
  const textDeltas = events.filter(e =>
    e.event === 'content_block_delta' && e.data?.delta?.type === 'text_delta'
  );
  const fullText = textDeltas.map(e => e.data?.delta?.text || '').join('');
  t.true(fullText.length > 50, `Model response should have substantial content (got ${fullText.length} chars)`);
  console.log(`  Response length: ${fullText.length} chars`);
  console.log(`  Response preview: "${fullText.slice(0, 150)}..."\n`);

  // CRITICAL: Verify server_tool_use usage is included in message_delta
  // This is what Claude Code uses to display "Did N searches" - if missing, it shows "0 searches"
  const messageDeltaEvents = events.filter(e => e.event === 'message_delta');
  const finalMessageDelta = messageDeltaEvents.find(e => e.data?.usage?.server_tool_use);

  t.truthy(finalMessageDelta,
    'REQUIRED: message_delta must include usage.server_tool_use. ' +
    'If this fails, the web_search_requests count is not being passed through to the client.');

  const webSearchRequests = finalMessageDelta?.data?.usage?.server_tool_use?.web_search_requests;
  t.truthy(webSearchRequests,
    'REQUIRED: usage.server_tool_use.web_search_requests must be present and > 0. ' +
    `Got: ${JSON.stringify(finalMessageDelta?.data?.usage)}`);
  t.true(webSearchRequests > 0,
    `REQUIRED: web_search_requests should be > 0, got ${webSearchRequests}`);
  console.log(`  ✓ server_tool_use.web_search_requests: ${webSearchRequests}`);
});
