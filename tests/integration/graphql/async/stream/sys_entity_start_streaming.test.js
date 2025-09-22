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

test.serial('sys_entity_start streaming works correctly', async (t) => {
  const response = await testServer.executeOperation({
    query: `
      query TestQuery($text: String!, $chatHistory: [MultiMessage]!, $stream: Boolean!) {
        sys_entity_start(text: $text, chatHistory: $chatHistory, stream: $stream) {
          result
          contextId
          tool
          warnings
          errors
        }
      }
    `,
    variables: {
      text: 'Tell me about the history of Al Jazeera',
      chatHistory: [{ role: "user", content: ["Tell me about the history of Al Jazeera"] }],
      stream: true
    }
  });

  const requestId = response.body?.singleResult?.data?.sys_entity_start?.result;
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
    variables: { requestId },
  }, 30000, { requireCompletion: false, minEvents: 1 });

  t.true(events.length > 0);
  for (const event of events) {
    const progress = event.data.requestProgress;
    validateProgressMessage(t, progress, requestId);
    if (progress.data) {
      const parsed = JSON.parse(progress.data);
      t.true(typeof parsed === 'string' || typeof parsed === 'object');
    }
  }
});


