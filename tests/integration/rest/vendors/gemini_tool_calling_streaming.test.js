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

test('Gemini streaming tool_calls appear as OAI deltas', async (t) => {
  const baseUrl = `http://localhost:${process.env.CORTEX_PORT}/v1`;

  // pick a Gemini-compatible model
  let model = 'gemini-flash-25-vision';
  try {
    const res = await got(`${baseUrl}/models`, { responseType: 'json' });
    const ids = (res.body?.data || []).map(m => m.id);
    model = ids.find(id => /^gemini|^google/i.test(id)) || model;
  } catch (_) {}

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

  const chunks = await collectSSEChunks(baseUrl, '/chat/completions', payload);

  t.true(chunks.length > 0);

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

  t.true(sawToolCall);
  t.is(toolName, 'sum');
  if (argsBuffer) t.true(/[\{\}"]/g.test(argsBuffer));
});


