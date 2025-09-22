import test from 'ava';
import serverFactory from '../../../../index.js';
import got from 'got';
import { collectSSEChunks, assertOAIChatChunkBasics, assertAnyContentDelta } from '../../../helpers/sseAssert.js';

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

test('Gemini SSE chat stream returns OAI-style chunks', async (t) => {
  const baseUrl = `http://localhost:${process.env.CORTEX_PORT}/v1`;

  // Pick an available Gemini model from /models
  let model = null;
  try {
    const res = await got(`${baseUrl}/models`, { responseType: 'json' });
    const ids = (res.body?.data || []).map(m => m.id);
    model = ids.find(id => /gemini/i.test(id));
  } catch (_) {}

  if (!model) {
    t.pass('Skipping - no Gemini model configured');
    return;
  }

  const payload = {
    model,
    messages: [{ role: 'user', content: 'Hi there!' }],
    stream: true,
  };

  try {
    const chunks = await collectSSEChunks(baseUrl, '/chat/completions', payload);
    t.true(chunks.length > 0);
    chunks.forEach(ch => assertOAIChatChunkBasics(t, ch));
    t.true(assertAnyContentDelta(chunks));
  } catch (err) {
    if (err?.response?.status === 404) {
      t.pass('Skipping - REST OAI endpoint not available for Gemini');
      return;
    }
    throw err;
  }
});


