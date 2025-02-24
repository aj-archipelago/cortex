// subscription.test.js
// Tests for GraphQL subscriptions and request progress messages

import test from 'ava';
import serverFactory from '../index.js';
import { createClient } from 'graphql-ws';
import ws from 'ws';

let testServer;
let wsClient;

test.before(async () => {
  process.env.CORTEX_ENABLE_REST = 'true';
  const { server, startServer } = await serverFactory();
  startServer && await startServer();
  testServer = server;

  // Create WebSocket client for subscriptions
  wsClient = createClient({
    url: 'ws://localhost:4000/graphql',
    webSocketImpl: ws,
    retryAttempts: 3,
    connectionParams: {},
    on: {
      error: (error) => {
        console.error('WS connection error:', error);
      }
    }
  });

  // Test the connection by making a simple subscription
  try {
    await new Promise((resolve, reject) => {
      const subscription = wsClient.subscribe(
        {
          query: `
            subscription TestConnection {
              requestProgress(requestIds: ["test"]) {
                requestId
              }
            }
          `
        },
        {
          next: () => {
            resolve();
          },
          error: reject,
          complete: () => {
            resolve();
          }
        }
      );

      // Add a timeout to avoid hanging
      setTimeout(() => {
        resolve();
      }, 2000);
    });
  } catch (error) {
    console.error('Failed to establish WebSocket connection:', error);
    throw error;
  }
});

test.after.always('cleanup', async () => {
  if (wsClient) {
    wsClient.dispose();
  }
  if (testServer) {
    await testServer.stop();
  }
});

// Helper function to create a subscription
async function createSubscription(query, variables) {
  return wsClient.subscribe(
    {
      query,
      variables
    },
    {
      next: () => {},
      error: (error) => console.error('Subscription error:', error),
      complete: () => {}
    }
  );
}

// Helper function to collect subscription events with support for different event types
async function collectSubscriptionEvents(subscription, timeout = 30000, options = {}) {
  const events = [];
  const { requireCompletion = true, minEvents = 1 } = options;

  return new Promise((resolve, reject) => {
    let timeoutId;
    
    const checkAndResolve = () => {
      if (!requireCompletion && events.length >= minEvents) {
        clearTimeout(timeoutId);
        unsubscribe();
        resolve(events);
      }
    };

    timeoutId = setTimeout(() => {
      // If we have any events at all when the timeout hits, consider it a success
      if (events.length > 0) {
        resolve(events);
      } else {
        // Only reject if we have no events at all
        reject(new Error('Subscription timed out with no events'));
      }
    }, timeout);

    const unsubscribe = wsClient.subscribe(
      {
        query: subscription.query,
        variables: subscription.variables
      },
      {
        next: (event) => {
          events.push(event);
          
          // Check for completion or minimum events
          if (requireCompletion && event?.data?.requestProgress?.progress === 1) {
            clearTimeout(timeoutId);
            unsubscribe();
            resolve(events);
          } else {
            checkAndResolve();
          }
        },
        error: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
        complete: () => {
          clearTimeout(timeoutId);
          resolve(events);
        }
      }
    );
  });
}

// Add validation helpers
function validateProgressMessage(t, progress, requestId = null) {
  // Basic field existence checks
  t.truthy(progress, 'progress field should exist');
  t.truthy(progress.requestId, 'requestId field should exist');
  t.truthy(progress.progress !== undefined, 'progress value should exist');
  
  if (requestId) {
    t.is(progress.requestId, requestId, 'Request ID should match throughout');
  }

  // Validate data field if present
  if (progress.data) {
    t.true(typeof progress.data === 'string', 'Data field should be a string');
    t.notThrows(() => JSON.parse(progress.data), 'Data should be valid JSON');
  }

  // Validate info field if present and not an error
  if (progress.info && !progress.info.startsWith('ERROR:')) {
    t.true(typeof progress.info === 'string', 'Info field should be a string');
    t.notThrows(() => {
      const parsedInfo = JSON.parse(progress.info);
      t.true(typeof parsedInfo === 'object', 'Info should be valid JSON object');
    }, 'Info should be valid JSON');
  }
}

test('Request progress messages have string data and info fields', async (t) => {
  // Execute an async pathway that will generate progress messages
  const response = await testServer.executeOperation({
    query: `
      query TestQuery($text: String!) {
        chat(text: $text, async: true, stream: true) {
          result
        }
      }
    `,
    variables: { 
      text: 'Generate a long response to test streaming'
    }
  });

  console.log('Response:', JSON.stringify(response, null, 2));

  // Get requestId from response
  const requestId = response.body?.singleResult?.data?.chat?.result;
  t.truthy(requestId, 'Should have a requestId in the result field');

  // Collect all events from the subscription
  const events = await collectSubscriptionEvents({
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

  console.log('Events received:', JSON.stringify(events, null, 2));
  t.true(events.length > 0, 'Should have received events');

  // Verify each event has string data and info fields
  for (const event of events) {
    console.log('Processing event:', JSON.stringify(event, null, 2));
    const progress = event.data.requestProgress;
    
    validateProgressMessage(t, progress, requestId);
  }
});

test('sys_entity_start streaming works correctly', async (t) => {
  // Execute sys_entity_start with streaming
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

  console.log('Initial Response:', JSON.stringify(response, null, 2));
  const requestId = response.body?.singleResult?.data?.sys_entity_start?.result;
  t.truthy(requestId, 'Should have a requestId in the result field');

  // Collect events with a longer timeout since this is a real streaming operation
  const events = await collectSubscriptionEvents({
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
    timeout: 30000, // Longer timeout for streaming response
    requireCompletion: false,
    minEvents: 1
  });

  console.log('Events received:', JSON.stringify(events, null, 2));
  t.true(events.length > 0, 'Should have received events');

  // Verify streaming data format matches expected structure
  for (const event of events) {
    console.log('Processing event:', JSON.stringify(event, null, 2));
    const progress = event.data.requestProgress;
    validateProgressMessage(t, progress, requestId);

    // Additional streaming-specific checks
    if (progress.data) {
      const parsed = JSON.parse(progress.data);
      t.true(
        typeof parsed === 'string' || 
        typeof parsed === 'object',
        'Data should be either a string or an object'
      );
    }
  }
});

test('Translate pathway handles chunked async processing correctly', async (t) => {
  // Create a long text that will be split into chunks
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

  // Execute translate with async mode
  const response = await testServer.executeOperation({
    query: `
      query TestQuery($text: String!, $to: String!) {
        translate_gpt4_omni(text: $text, to: $to, async: true) {
          result
        }
      }
    `,
    variables: { 
      text: longText,
      to: 'Spanish'
    }
  });

  console.log('Initial Response:', JSON.stringify(response, null, 2));
  const requestId = response.body?.singleResult?.data?.translate_gpt4_omni?.result;
  t.truthy(requestId, 'Should have a requestId in the result field');

  // Collect events with a longer timeout since this is a chunked operation
  const events = await collectSubscriptionEvents({
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
    timeout: 180000, // 3 minutes for large chunked processing
    requireCompletion: true
  });

  console.log('Events received:', JSON.stringify(events, null, 2));
  t.true(events.length > 0, 'Should have received events');

  // Track progress values to ensure they increase
  let lastProgress = -1;
  let finalTranslation = null;
  let progressValues = new Set();
  let processingMessages = 0;

  // Verify progress messages and final data
  for (const event of events) {
    console.log('Processing event:', JSON.stringify(event, null, 2));
    const progress = event.data.requestProgress;
    
    validateProgressMessage(t, progress, requestId);

    // Verify progress increases
    if (progress.progress !== null) {
      t.true(progress.progress >= lastProgress, 'Progress should increase monotonically');
      t.true(progress.progress >= 0 && progress.progress <= 1, 'Progress should be between 0 and 1');
      progressValues.add(progress.progress);
      lastProgress = progress.progress;
    }

    // Only expect translated data when progress is 1
    if (progress.progress === 1) {
      t.truthy(progress.data, 'Should have data in final progress message');
      const parsed = JSON.parse(progress.data);
      t.true(typeof parsed === 'string', 'Final data should be a string containing translation');
      t.true(parsed.length > 0, 'Translation should not be empty');
      finalTranslation = parsed;
    } else {
      // Count any non-final progress message
      processingMessages++;
    }
  }

  // Verify we got multiple distinct progress updates
  t.true(progressValues.size >= 2, 'Should have at least 2 different progress values');
  t.true(processingMessages >= 1, 'Should have at least one processing status message');

  // Verify we got to completion with final translation
  t.is(lastProgress, 1, 'Should have reached completion (progress = 1)');
  t.truthy(finalTranslation, 'Should have received final translation');
}); 