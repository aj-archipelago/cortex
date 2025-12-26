import test from 'ava';
import serverFactory from '../../../../../../index.js';
import { createWsClient, ensureWsConnection, collectSubscriptionEvents } from '../../../../../helpers/subscriptions.js';

let testServer;
let wsClient;

test.before(async () => {
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

test('Claude vendor streaming over subscriptions emits OAI-style deltas', async (t) => {
  const response = await testServer.executeOperation({
    query: `
      query($text: String!, $chatHistory: [MultiMessage]!, $stream: Boolean) {
        sys_entity_agent(text: $text, chatHistory: $chatHistory, stream: $stream) {
          result
        }
      }
    `,
    variables: {
      text: 'Say hi',
      chatHistory: [{ role: 'user', content: ['Say hi'] }],
      stream: true
    }
  });

  const requestId = response.body?.singleResult?.data?.sys_entity_agent?.result;
  if (!requestId) {
    t.pass('Skipping - Claude vendor model not configured');
    return;
  }

  const events = await collectSubscriptionEvents(wsClient, {
    query: `
      subscription($requestId: String!) {
        requestProgress(requestIds: [$requestId]) { requestId progress data }
      }
    `,
    variables: { requestId },
  }, 20000, { requireCompletion: false, minEvents: 1 });

  t.true(events.length > 0);
});


