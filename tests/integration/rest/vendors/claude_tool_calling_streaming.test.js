import test from 'ava';
import serverFactory from '../../../../index.js';
import { collectSSEChunks } from '../../../helpers/sseAssert.js';
import got from 'got';

let testServer;

const streamText = (chunks) => chunks
  .map(chunk => chunk?.choices?.[0]?.delta?.content)
  .filter(text => typeof text === 'string')
  .join('');

const isProviderCredentialError = (text) =>
  /PERMISSION_DENIED|SERVICE_DISABLED|API has not been used|project-id|invalid_grant|unauthorized|forbidden|credential/i.test(text || '');

const selectClaudeVertexModel = async (baseUrl) => {
  const res = await got(`${baseUrl}/models`, { responseType: 'json' });
  const ids = (res.body?.data || []).map(m => m.id);
  return ids.find(id => /^claude-sonnet-4/i.test(id))
    || ids.find(id => /^claude-(4|46)-sonnet-vertex$/i.test(id))
    || ids.find(id => /^claude-.*sonnet/i.test(id))
    || ids.find(id => /^claude-.*sonnet.*vertex/i.test(id))
    || ids.find(id => /^claude-.*vertex/i.test(id))
    || ids.find(id => /^claude|^anthropic/i.test(id))
    || null;
};

test.before(async () => {
  process.env.CORTEX_ENABLE_REST = 'true';
  const { server, startServer } = await serverFactory();
  startServer && await startServer();
  testServer = server;
});

test.after.always('cleanup', async () => {
  if (testServer) await testServer.stop();
});

test('Claude streaming tool_calls appear as OAI deltas', async (t) => {
  const baseUrl = `http://localhost:${process.env.CORTEX_PORT}/v1`;

  // pick a Claude-compatible model
  let model = null;
  try {
    model = await selectClaudeVertexModel(baseUrl);
  } catch (_) {}
  if (!model) {
    t.pass('Skipping - no Claude-compatible model is exposed');
    return;
  }

  const payload = {
    model,
    messages: [
      { role: 'system', content: 'If the user asks to sum numbers, call the sum tool.' },
      { role: 'user', content: 'Sum 2 and 3.' }
    ],
    tool_choice: { type: 'function', function: 'sum' },
    tools: [
      {
        type: 'function',
        function: {
          name: 'sum',
          description: 'Sum two numbers',
          parameters: {
            type: 'object',
            properties: { a: { type: 'number' }, b: { type: 'number' } },
            required: ['a', 'b']
          }
        }
      }
    ],
    stream: true,
  };

  let chunks;
  try {
    chunks = await collectSSEChunks(baseUrl, '/chat/completions', payload);
  } catch (err) {
    const status = err?.response?.status;
    if (status === 403 || status === 404) {
      t.pass('Skipping - Claude-compatible model is not usable in this environment');
      return;
    }
    throw err;
  }

  t.true(chunks.length > 0);
  if (isProviderCredentialError(streamText(chunks))) {
    t.pass('Skipping - Claude-compatible model is not usable in this environment');
    return;
  }

  let sawToolCall = false;
  let toolName = '';
  let argsBuffer = '';
  for (const ch of chunks) {
    const tc = ch?.choices?.[0]?.delta?.tool_calls?.[0];
    if (tc) {
      sawToolCall = true;
      if (tc.function?.name) toolName = tc.function.name || toolName;
      if (tc.function?.arguments) argsBuffer += tc.function.arguments;
    }
  }

  t.true(sawToolCall, 'Forced Claude tool_choice should emit streaming tool_call deltas');
  t.is(toolName, 'sum');
  if (argsBuffer) t.true(/[\{\}"]/g.test(argsBuffer));
});
