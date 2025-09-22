// grok_streaming.test.js
// Basic text streaming test for Grok-4 via OpenAI REST API

import test from 'ava';
import serverFactory from '../../../../index.js';
import { connectToSSEEndpoint } from '../../../helpers/sseClient.js';

const API_BASE = `http://localhost:${process.env.CORTEX_PORT}/v1`;

let testServer;

test.before(async () => {
  process.env.CORTEX_ENABLE_REST = 'true';
  const { server, startServer } = await serverFactory();
  startServer && await startServer();
  testServer = server;
});

test.after.always('cleanup', async () => {
  if (testServer) {
    await testServer.stop();
  }
});

test('POST SSE: /v1/chat/completions should stream text response from Grok-4', async (t) => {
  const payload = {
    model: 'grok-4',
    messages: [
      {
        role: 'user',
        content: 'Hello! Please introduce yourself.',
      },
    ],
    stream: true,
  };
  
  const url = `http://localhost:${process.env.CORTEX_PORT}/v1`;
  
  let completeMessage = '';

  await connectToSSEEndpoint(url, '/chat/completions', payload, (messageJson) => {
    t.truthy(messageJson.id);
    t.is(messageJson.object, 'chat.completion.chunk');
    t.truthy(messageJson.choices[0].delta);
    t.truthy(messageJson.choices[0].finish_reason === null || messageJson.choices[0].finish_reason === 'stop');
    if (messageJson.choices?.[0]?.delta?.content) {
      completeMessage += messageJson.choices[0].delta.content;
    }
  });

  t.truthy(completeMessage);
  t.true(completeMessage.length > 0);
});


