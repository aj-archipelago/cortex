import test from 'ava';
import serverFactory from '../../../../index.js';
import { createWsClient, ensureWsConnection } from '../../../helpers/subscriptions.js';

let testServer;
let wsClient;

test.before(async () => {
  process.env.CORTEX_ENABLE_REST = 'true';
  const { server, startServer } = await serverFactory();
  startServer && await startServer();
  testServer = server;

  wsClient = createWsClient();
});

test.after.always('cleanup', async () => {
  if (wsClient) wsClient.dispose();
  if (testServer) await testServer.stop();
});

test('WebSocket connection can subscribe', async (t) => {
  await t.notThrowsAsync(() => ensureWsConnection(wsClient));
});


