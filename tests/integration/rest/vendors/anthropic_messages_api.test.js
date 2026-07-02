/**
 * Opt-in live integration tests for Anthropic Messages API compatibility.
 *
 * Run with:
 * CORTEX_RUN_ANTHROPIC_MESSAGES_LIVE_TESTS=true node -r dotenv/config ./node_modules/ava/entrypoints/cli.mjs tests/integration/rest/vendors/anthropic_messages_api.test.js --timeout=180s --concurrency=1
 */
import test from 'ava';
import got from 'got';
import serverFactory from '../../../../index.js';
import { collectAnthropicSSE } from '../../../helpers/anthropicSseClient.js';

const RUN_LIVE =
  process.env.CORTEX_RUN_ANTHROPIC_MESSAGES_LIVE_TESTS === 'true' ||
  process.env.CORTEX_RUN_VENDOR_LIVE_TESTS === 'true';

let testServer;
let testPort;

test.before(async () => {
  if (!RUN_LIVE) return;
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

const skipUnlessLive = (t) => {
  if (RUN_LIVE) return false;
  t.pass('Skipping live Anthropic Messages API integration tests');
  return true;
};

async function getModelIds(t, baseUrl) {
  try {
    const response = await got(`${baseUrl}/models`, { responseType: 'json' });
    return (response.body?.data || []).map(model => model.id);
  } catch (error) {
    t.fail(`Failed to get models: ${error.message}`);
    return [];
  }
}

async function findClaudeModel(t, baseUrl, predicate = () => true) {
  const ids = await getModelIds(t, baseUrl);
  const model = ids.find(id => /^claude-/i.test(id) && predicate(id));
  if (!model) {
    t.pass('Skipping - no matching Claude model configured');
    return null;
  }
  return model;
}

test('Anthropic Messages API non-streaming response shape', async (t) => {
  if (skipUnlessLive(t)) return;

  const baseUrl = `http://localhost:${testPort}/v1`;
  const model = await findClaudeModel(t, baseUrl);
  if (!model) return;

  const payload = {
    model,
    system: 'You are a helpful assistant.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Say hello in one short sentence.' }] },
    ],
    tools: [
      {
        name: 'noop_tool',
        description: 'No-op tool for testing',
        input_schema: { type: 'object', properties: {} },
      },
    ],
    tool_choice: { type: 'auto' },
    max_tokens: 32,
  };

  const response = await got.post(`${baseUrl}/messages`, {
    json: payload,
    responseType: 'json',
    timeout: { request: 60000 },
  });

  t.truthy(response.body);
  t.is(response.body.type, 'message');
  t.is(response.body.role, 'assistant');
  t.true(Array.isArray(response.body.content));
  t.truthy(response.body.content[0]);
});

test('Anthropic Messages API streaming emits message_start and message_stop', async (t) => {
  if (skipUnlessLive(t)) return;

  const baseUrl = `http://localhost:${testPort}/v1`;
  const model = await findClaudeModel(t, baseUrl);
  if (!model) return;

  const payload = {
    model,
    system: 'You are a helpful assistant.',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Reply with a short greeting.' }] },
    ],
    stream: true,
    max_tokens: 64,
  };

  const events = await collectAnthropicSSE(baseUrl, '/messages', payload);
  t.true(events.length > 0);
  t.true(events.some(event => event.event === 'message_start'));
  t.true(events.some(event => event.event === 'message_stop'));
  t.true(events.some(event => event.event === 'message_delta' && event.data?.usage));
});

test('Anthropic Messages API web_search_20250305 server-side tool streaming', async (t) => {
  if (skipUnlessLive(t)) return;

  const baseUrl = `http://localhost:${testPort}/v1`;
  const model = await findClaudeModel(t, baseUrl, id => /opus|sonnet/i.test(id));
  if (!model) return;

  const payload = {
    model,
    system: 'You are a helpful assistant with web search capabilities.',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'What is the current weather in Tokyo? Use web search to find out.' }],
      },
    ],
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 3,
      },
    ],
    stream: true,
    max_tokens: 1024,
  };

  const events = await collectAnthropicSSE(baseUrl, '/messages', payload, 120000);
  t.true(events.length > 0);
  t.true(events.some(event => event.event === 'message_start'));
  t.true(events.some(event => event.event === 'message_stop'));

  const contentBlockStarts = events.filter(event => event.event === 'content_block_start');
  const blockTypes = contentBlockStarts.map(event => event.data?.content_block?.type).join(', ') || '(none)';
  const serverToolUseStart = contentBlockStarts.find(event => event.data?.content_block?.type === 'server_tool_use');
  const webSearchResultStart = contentBlockStarts.find(event => event.data?.content_block?.type === 'web_search_tool_result');

  t.truthy(
    serverToolUseStart,
    `Expected server_tool_use block. Got blocks: [${blockTypes}]`,
  );
  t.truthy(serverToolUseStart.data.content_block.id);
  t.is(serverToolUseStart.data.content_block.name, 'web_search');

  const serverToolUseIndex = serverToolUseStart.data.index;
  const serverToolDeltas = events.filter(event =>
    event.event === 'content_block_delta' &&
    event.data?.index === serverToolUseIndex &&
    event.data?.delta?.type === 'input_json_delta'
  );
  t.true(serverToolDeltas.length > 0);

  t.truthy(
    webSearchResultStart,
    `Expected web_search_tool_result block. Got blocks: [${blockTypes}]`,
  );
  t.truthy(webSearchResultStart.data.content_block.tool_use_id);

  const searchResults = webSearchResultStart.data.content_block.content || [];
  t.true(searchResults.length > 0);
  if (searchResults[0]?.type === 'web_search_result') {
    t.truthy(searchResults[0].url);
    t.truthy(searchResults[0].title || searchResults[0].snippet || searchResults[0].content);
  }

  const textDeltas = events.filter(event =>
    event.event === 'content_block_delta' &&
    event.data?.delta?.type === 'text_delta'
  );
  const fullText = textDeltas.map(event => event.data?.delta?.text || '').join('');
  t.true(fullText.length > 50);

  const finalMessageDelta = events
    .filter(event => event.event === 'message_delta')
    .find(event => event.data?.usage?.server_tool_use);
  t.truthy(finalMessageDelta);
  const webSearchRequests = finalMessageDelta?.data?.usage?.server_tool_use?.web_search_requests;
  t.true(webSearchRequests > 0);
});
