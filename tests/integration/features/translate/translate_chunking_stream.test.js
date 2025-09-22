import test from 'ava';
import serverFactory from '../../../../index.js';
import { createWsClient, ensureWsConnection, collectSubscriptionEvents, validateProgressMessage } from '../../../helpers/subscriptions.js';

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

test.serial('Translate pathway handles chunked async processing correctly', async (t) => {
  const longText = `In the heart of the bustling metropolis, where skyscrapers pierce the clouds and streets pulse with endless energy, 
    a story unfolds. It's a tale of innovation and perseverance, of dreams taking flight in the digital age. 
    Entrepreneurs and visionaries gather in gleaming office towers, their minds focused on the next breakthrough that will reshape our world.
    In labs and workshops, engineers and designers collaborate, their fingers dancing across keyboards as they write the future in lines of code.
    The city never sleeps, its rhythm maintained by the constant flow of ideas and ambition. Coffee shops become impromptu meeting rooms,
    where startups are born on napkins and partnerships forged over steaming lattes. The energy is palpable, electric, contagious.
    In the background, servers hum in vast data centers, processing countless transactions and storing the collective knowledge of humanity.
    The digital revolution continues unabated, transforming how we live, work, and connect with one another.
    Young graduates fresh from university mingle with seasoned veterans, each bringing their unique perspective to the challenges at hand.
    The boundaries between traditional industries blur as technology weaves its way into every aspect of business and society.
    This is the story of progress, of human ingenuity pushing the boundaries of what's possible.
    It's a narrative that continues to evolve, page by digital page, in the great book of human achievement.`.repeat(10);

  const response = await testServer.executeOperation({
    query: `
      query TestQuery($text: String!, $to: String!) {
        translate_gpt4_omni(text: $text, to: $to, async: true) {
          result
        }
      }
    `,
    variables: { text: longText, to: 'Spanish' }
  });

  const requestId = response.body?.singleResult?.data?.translate_gpt4_omni?.result;
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
  }, 180000, { requireCompletion: true });

  t.true(events.length > 0);

  let lastProgress = -1;
  let finalTranslation = null;
  let progressValues = new Set();
  let processingMessages = 0;

  for (const event of events) {
    const progress = event.data.requestProgress;
    validateProgressMessage(t, progress, requestId);

    if (progress.progress !== null) {
      t.true(progress.progress >= lastProgress);
      t.true(progress.progress >= 0 && progress.progress <= 1);
      progressValues.add(progress.progress);
      lastProgress = progress.progress;
    }

    if (progress.progress === 1) {
      t.truthy(progress.data);
      const parsed = JSON.parse(progress.data);
      t.true(typeof parsed === 'string');
      t.true(parsed.length > 0);
      finalTranslation = parsed;
    } else {
      processingMessages++;
    }
  }

  t.true(progressValues.size >= 2);
  t.true(processingMessages >= 1);
  t.is(lastProgress, 1);
  t.truthy(finalTranslation);
});


