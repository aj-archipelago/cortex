// Consolidated GraphQL subscription streaming tests (subset from subscription.test.js)

import test from 'ava';
import serverFactory from '../../../../../index.js';
import { createWsClient, ensureWsConnection, collectSubscriptionEvents, validateProgressMessage } from '../../../../helpers/subscriptions.js';

let testServer;
let wsClient;

test.before(async () => {
  process.env.CORTEX_ENABLE_REST = 'true';
  const { server, startServer } = await serverFactory();
  startServer && await startServer();
  testServer = server;

  wsClient = createWsClient();
  await ensureWsConnection(wsClient);
});

test.after.always('cleanup', async () => {
  if (wsClient) wsClient.dispose();
  if (testServer) await testServer.stop();
});

test.serial('Request progress messages have string data and info fields', async (t) => {
  const response = await testServer.executeOperation({
    query: `
      query TestQuery($text: String!) {
        chat(text: $text, async: true, stream: true) {
          result
        }
      }
    `,
    variables: { text: 'Generate a long response to test streaming' }
  });

  const requestId = response.body?.singleResult?.data?.chat?.result;
  t.truthy(requestId);

  const events = await collectSubscriptionEvents(wsClient, {
    query: `
      subscription OnRequestProgress($requestId: String!) {
        requestProgress(requestIds: [$requestId]) {
          requestId
          progress
          data
          info
        }
      }
    `,
    variables: { requestId }
  }, 10000, { requireCompletion: false, minEvents: 1 });

  t.true(events.length > 0);

  for (const event of events) {
    const progress = event.data.requestProgress;
    validateProgressMessage(t, progress, requestId);
  }
});


