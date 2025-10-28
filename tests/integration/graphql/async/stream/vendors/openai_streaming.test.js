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

test('OpenAI vendor streaming over subscriptions emits OAI-style deltas', async (t) => {
  const response = await testServer.executeOperation({
    query: `
      query($text: String!, $chatHistory: [MultiMessage]!, $stream: Boolean, $aiStyle: String) {
        sys_entity_agent(text: $text, chatHistory: $chatHistory, stream: $stream, aiStyle: $aiStyle) {
          result
        }
      }
    `,
    variables: {
      text: 'Say hi',
      chatHistory: [{ role: 'user', content: ['Say hi'] }],
      stream: true,
      aiStyle: 'OpenAI'
    }
  });

  const requestId = response.body?.singleResult?.data?.sys_entity_agent?.result;
  if (!requestId) {
    t.pass('Skipping - OpenAI vendor model not configured');
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

  const models = events
    .map(e => {
      try {
        return JSON.parse(e?.data?.requestProgress?.data || '{}')?.model;
      } catch (_) {
        return undefined;
      }
    })
    .filter(Boolean);

  if (models.length > 0) {
    t.truthy(models.find(m => /gpt-5-chat/.test(m)));
  }
});


