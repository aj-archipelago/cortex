import test from 'ava';
import serverFactory from '../../../../index.js';
import got from 'got';
import { collectSSEChunks, assertOAIChatChunkBasics, assertAnyContentDelta } from '../../../helpers/sseAssert.js';

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

test('Gemini SSE chat stream returns OAI-style chunks', async (t) => {
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
    messages: [{ role: 'user', content: 'Hi there!' }],
    stream: true,
  };

  const chunks = await collectSSEChunks(baseUrl, '/chat/completions', payload);
  t.true(chunks.length > 0);
  chunks.forEach(ch => assertOAIChatChunkBasics(t, ch));
  if (isProviderCredentialError(streamText(chunks))) {
    t.pass('Skipping - Gemini provider is not usable in this environment');
    return;
  }
  t.true(assertAnyContentDelta(chunks), 'Gemini stream should include at least one text delta');
});
