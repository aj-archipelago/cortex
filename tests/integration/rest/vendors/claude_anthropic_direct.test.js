/**
 * E2E integration test for direct Anthropic API access (not via Vertex AI)
 * Tests the CLAUDE-ANTHROPIC plugin type with Claude models
 * 
 * Run with: npm test -- tests/integration/rest/vendors/claude_anthropic_direct.test.js
 */
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

// Test: Basic streaming chat completion with Claude 4.5 Sonnet via direct Anthropic API
test('Claude 4.5 Sonnet (direct Anthropic) SSE streaming chat', async (t) => {
  const baseUrl = `http://localhost:${process.env.CORTEX_PORT}/v1`;

  // Use the direct Anthropic model (claude-45-sonnet)
  const model = 'claude-45-sonnet';
  
  // Verify the model is available
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
    messages: [{ role: 'user', content: 'Say "Hello from Anthropic direct API!" and nothing else.' }],
    stream: true,
  };

  const chunks = await collectSSEChunks(baseUrl, '/chat/completions', payload);
  t.true(chunks.length > 0, 'Should receive SSE chunks');
  chunks.forEach(ch => assertOAIChatChunkBasics(t, ch));
  t.true(assertAnyContentDelta(chunks), 'Should have content delta in chunks');
  
  // Log the full response for debugging
  const fullContent = chunks
    .map(c => c?.choices?.[0]?.delta?.content || '')
    .join('');
  t.log(`Response: ${fullContent}`);
});

// Test: Non-streaming chat completion with Claude 4.5 Sonnet via direct Anthropic API
test('Claude 4.5 Sonnet (direct Anthropic) non-streaming chat', async (t) => {
  const baseUrl = `http://localhost:${process.env.CORTEX_PORT}/v1`;
  const model = 'claude-45-sonnet';

  // Verify the model is available
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
    messages: [{ role: 'user', content: 'What is 2 + 2? Reply with just the number.' }],
    stream: false,
  };

  try {
    const response = await got.post(`${baseUrl}/chat/completions`, {
      json: payload,
      responseType: 'json',
      timeout: { request: 60000 }
    });

    t.truthy(response.body, 'Should have response body');
    t.truthy(response.body.choices, 'Should have choices');
    t.truthy(response.body.choices[0].message, 'Should have message');
    t.truthy(response.body.choices[0].message.content, 'Should have content');
    
    t.log(`Response: ${response.body.choices[0].message.content}`);
  } catch (err) {
    t.fail(`Request failed: ${err.message}`);
  }
});

// Test: Chat with system message
test('Claude 4.5 Sonnet (direct Anthropic) with system message', async (t) => {
  const baseUrl = `http://localhost:${process.env.CORTEX_PORT}/v1`;
  const model = 'claude-45-sonnet';

  // Verify the model is available
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
    messages: [
      { role: 'system', content: 'You are a pirate. Always respond in pirate speak.' },
      { role: 'user', content: 'Hello!' }
    ],
    stream: true,
  };

  const chunks = await collectSSEChunks(baseUrl, '/chat/completions', payload);
  t.true(chunks.length > 0, 'Should receive SSE chunks');
  chunks.forEach(ch => assertOAIChatChunkBasics(t, ch));
  t.true(assertAnyContentDelta(chunks), 'Should have content delta in chunks');
  
  const fullContent = chunks
    .map(c => c?.choices?.[0]?.delta?.content || '')
    .join('');
  t.log(`Response: ${fullContent}`);
  // Should contain pirate-like language
  t.regex(fullContent.toLowerCase(), /ahoy|arr|matey|ye|cap|sail|treasure/i, 'Should respond in pirate speak');
});

// Test: Document block support (PDF)
test('Claude 4.5 Sonnet (direct Anthropic) with PDF document', async (t) => {
  const baseUrl = `http://localhost:${process.env.CORTEX_PORT}/v1`;
  const model = 'claude-45-sonnet';

  // Verify the model is available
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

  // Minimal valid PDF
  const pdfContent = '%PDF-1.4\n%âãÏÓ\n1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n3 0 obj\n<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/MediaBox[0 0 612 792]/Contents 5 0 R>>\nendobj\n4 0 obj\n<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\nendobj\n5 0 obj\n<</Length 44>>\nstream\nBT\n/F1 12 Tf\n100 700 Td\n(Test PDF Doc) Tj\nET\nendstream\nendobj\nxref\n0 6\n0000000000 65535 f\n0000000010 00000 n\n0000000053 00000 n\n0000000102 00000 n\n0000000211 00000 n\n0000000280 00000 n\ntrailer\n<</Size 6/Root 1 0 R>>\nstartxref\n369\n%%EOF';
  const base64Pdf = Buffer.from(pdfContent).toString('base64');

  const payload = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What text is in this PDF? Reply with just the text you see.' },
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

  const chunks = await collectSSEChunks(baseUrl, '/chat/completions', payload);
  t.true(chunks.length > 0, 'Should receive SSE chunks');
  chunks.forEach(ch => assertOAIChatChunkBasics(t, ch));
  t.true(assertAnyContentDelta(chunks), 'Should have content delta in chunks');
  
  const fullContent = chunks
    .map(c => c?.choices?.[0]?.delta?.content || '')
    .join('');
  t.log(`Response: ${fullContent}`);
});
