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

const selectGemini35FlashModel = async (baseUrl) => {
  const res = await got(`${baseUrl}/models`, { responseType: 'json' });
  const ids = (res.body?.data || []).map(m => m.id);
  return ids.find(id => /^gemini-flash-35(?:$|-)/i.test(id))
    || ids.find(id => /gemini.*(?:3\.5|35).*flash|flash.*(?:3\.5|35)/i.test(id))
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

test('Gemini streaming tool_calls appear as OAI deltas', async (t) => {
  const baseUrl = `http://localhost:${process.env.CORTEX_PORT}/v1`;

  // Pick the current enabled Gemini family. Older Gemini models are disabled.
  let model = null;
  try {
    model = await selectGemini35FlashModel(baseUrl);
  } catch (_) {}
  if (!model) {
    t.pass('Skipping - no Gemini 3.5 Flash model configured');
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

  const chunks = await collectSSEChunks(baseUrl, '/chat/completions', payload);

  t.true(chunks.length > 0);
  if (isProviderCredentialError(streamText(chunks))) {
    t.pass('Skipping - Gemini provider is not usable in this environment');
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

  t.true(sawToolCall, 'Forced Gemini tool_choice should emit streaming tool_call deltas');
  t.is(toolName, 'sum');
  if (argsBuffer) t.true(/[\{\}"]/g.test(argsBuffer));
});
