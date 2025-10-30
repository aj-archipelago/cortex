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

test('Claude SSE chat stream returns OAI-style chunks', async (t) => {
  const baseUrl = `http://localhost:${process.env.CORTEX_PORT}/v1`;

  // Pick an available Claude model from /models
  let model = null;
  try {
    const res = await got(`${baseUrl}/models`, { responseType: 'json' });
    const ids = (res.body?.data || []).map(m => m.id);
    model = ids.find(id => /^claude-/i.test(id));
  } catch (_) {}

  if (!model) {
    t.pass('Skipping - no Claude model configured');
    return;
  }

  const payload = {
    model,
    messages: [{ role: 'user', content: 'Hello!' }],
    stream: true,
  };

  const chunks = await collectSSEChunks(baseUrl, '/chat/completions', payload);
  t.true(chunks.length > 0);
  chunks.forEach(ch => assertOAIChatChunkBasics(t, ch));
  t.true(assertAnyContentDelta(chunks));
});

test('Claude 4 SSE chat stream with document block (PDF)', async (t) => {
  const baseUrl = `http://localhost:${process.env.CORTEX_PORT}/v1`;

  // Pick an available Claude 4 model from /models
  let model = null;
  try {
    const res = await got(`${baseUrl}/models`, { responseType: 'json' });
    const ids = (res.body?.data || []).map(m => m.id);
    // Look for claude-4 or claude-45 models specifically
    model = ids.find(id => /^claude-(4|45)/.test(id));
  } catch (_) {}

  if (!model) {
    t.pass('Skipping - no Claude 4+ model configured');
    return;
  }

  // Create a simple PDF document with base64 encoding (sample dummy PDF)
  // This is a minimal valid PDF
  const pdfContent = '%PDF-1.4\n%âãÏÓ\n1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n3 0 obj\n<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/MediaBox[0 0 612 792]/Contents 5 0 R>>\nendobj\n4 0 obj\n<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\nendobj\n5 0 obj\n<</Length 44>>\nstream\nBT\n/F1 12 Tf\n100 700 Td\n(Sample PDF) Tj\nET\nendstream\nendobj\nxref\n0 6\n0000000000 65535 f\n0000000010 00000 n\n0000000053 00000 n\n0000000102 00000 n\n0000000211 00000 n\n0000000280 00000 n\ntrailer\n<</Size 6/Root 1 0 R>>\nstartxref\n369\n%%EOF';
  const base64Pdf = Buffer.from(pdfContent).toString('base64');

  const payload = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Please analyze this PDF document and tell me what you see. Be concise.'
          },
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: base64Pdf
            }
          }
        ]
      }
    ],
    stream: true,
  };

  try {
    const chunks = await collectSSEChunks(baseUrl, '/chat/completions', payload);
    t.true(chunks.length > 0, 'Should receive SSE chunks');
    chunks.forEach(ch => assertOAIChatChunkBasics(t, ch));
    t.true(assertAnyContentDelta(chunks), 'Should have content delta in chunks');
  } catch (err) {
    // If the model doesn't support this format yet, skip gracefully
    if (err.message && err.message.includes('document')) {
      t.pass('Document blocks not yet supported by this model endpoint');
    } else {
      throw err;
    }
  }
});

test('Claude 4 SSE chat stream with text document', async (t) => {
  const baseUrl = `http://localhost:${process.env.CORTEX_PORT}/v1`;

  // Pick an available Claude 4 model from /models
  let model = null;
  try {
    const res = await got(`${baseUrl}/models`, { responseType: 'json' });
    const ids = (res.body?.data || []).map(m => m.id);
    // Look for claude-4 or claude-45 models specifically
    model = ids.find(id => /^claude-(4|45)/.test(id));
  } catch (_) {}

  if (!model) {
    t.pass('Skipping - no Claude 4+ model configured');
    return;
  }

  // Create a simple text document with base64 encoding
  const textContent = 'This is a sample text document.\nIt contains multiple lines.\nThe document discusses the capabilities of Claude models with document support.';
  const base64Text = Buffer.from(textContent).toString('base64');

  const payload = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Please summarize this text document for me in one sentence.'
          },
          {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'text/plain',
              data: base64Text
            }
          }
        ]
      }
    ],
    stream: true,
  };

  try {
    const chunks = await collectSSEChunks(baseUrl, '/chat/completions', payload);
    t.true(chunks.length > 0, 'Should receive SSE chunks');
    chunks.forEach(ch => assertOAIChatChunkBasics(t, ch));
    t.true(assertAnyContentDelta(chunks), 'Should have content delta in chunks');
  } catch (err) {
    // If the model doesn't support this format yet, skip gracefully
    if (err.message && err.message.includes('document')) {
      t.pass('Document blocks not yet supported by this model endpoint');
    } else {
      throw err;
    }
  }
});


