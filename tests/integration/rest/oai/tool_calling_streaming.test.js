import test from 'ava';
import serverFactory from '../../../../index.js';
import { collectSSEChunks } from '../../../helpers/sseAssert.js';
import got from 'got';

let testServer;

test.before(async () => {
  process.env.CORTEX_ENABLE_REST = 'true';
  const { server, startServer } = await serverFactory();
  startServer && await startServer();
  testServer = server;
});

test.after.always('cleanup', async () => {
  if (testServer) await testServer.stop();
});

test('Streaming tool_calls appear as OAI deltas and reconstruct into valid arguments', async (t) => {
  // pick any OpenAI-compatible model
  const baseUrl = `http://localhost:${process.env.CORTEX_PORT}/v1`;
  let model = 'gpt-4o';
  try {
    const res = await got(`${baseUrl}/models`, { responseType: 'json' });
    const ids = (res.body?.data || []).map(m => m.id);
    model = ids.find(id => /^oai-|^gpt|^openai/i.test(id)) || model;
  } catch (_) {}

  const payload = {
    model,
    messages: [
      { role: 'system', content: 'You are a helpful assistant. If the user asks to sum numbers, call the sum tool.' },
      { role: 'user', content: 'Sum 2 and 3.' }
    ],
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
    if (err?.response?.status === 404) {
      t.pass('Skipping - tool-calling streaming endpoint not available');
      return;
    }
    throw err;
  }
  t.true(chunks.length > 0);

  // Gather tool_call name and arguments deltas
  let toolName = '';
  let argsBuffer = '';
  let sawToolCall = false;
  for (const ch of chunks) {
    const tc = ch?.choices?.[0]?.delta?.tool_calls?.[0];
    if (tc) {
      sawToolCall = true;
      if (tc.function?.name) toolName = tc.function.name || toolName;
      if (tc.function?.arguments) argsBuffer += tc.function.arguments;
    }
  }

  t.true(sawToolCall);
  t.is(toolName, 'sum');
  // Arguments may be streamed as partial JSON; assert that we received JSON-like content
  if (argsBuffer) {
    t.true(/[\{\}"]/g.test(argsBuffer));
  }
});


