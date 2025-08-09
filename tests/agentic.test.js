// agentic.test.js
// Tests for the agentic entity system

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
    url: `ws://localhost:${process.env.CORTEX_PORT || 4000}/graphql`,
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

// Helper function to collect subscription events
async function collectSubscriptionEvents(subscription, timeout = 30000) {
  const events = [];

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      if (events.length > 0) {
        resolve(events);
      } else {
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
          if (event?.data?.requestProgress?.progress === 1) {
            clearTimeout(timeoutId);
            unsubscribe();
            resolve(events);
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

// Test basic single-step task
test.serial('sys_entity_agent handles single-step task', async (t) => {
  t.timeout(30000); // 30 second timeout
  const response = await testServer.executeOperation({
    query: `
      query TestAgentSingleStep(
        $text: String!, 
        $chatHistory: [MultiMessage]!
      ) {
        sys_entity_agent(
          text: $text, 
          chatHistory: $chatHistory,
          stream: true
        ) {
          result
          contextId
          tool
          warnings
          errors
        }
      }
    `,
    variables: {
      text: 'What is the current time?',
      chatHistory: [{
        role: "user",
        content: ["What is the current time?"]
      }]
    }
  });

  console.log('Single-step Agent Response:', JSON.stringify(response, null, 2));

  // Check for successful response
  t.falsy(response.body?.singleResult?.errors, 'Should not have GraphQL errors');
  const requestId = response.body?.singleResult?.data?.sys_entity_agent?.result;
  t.truthy(requestId, 'Should have a requestId in the result field');

  // Collect events
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
  });

  console.log(`Received ${events.length} events for single-step task`);
  t.true(events.length > 0, 'Should have received events');

  // Verify we got a completion event
  const completionEvent = events.find(event =>
    event.data.requestProgress.progress === 1
  );
  t.truthy(completionEvent, 'Should have received a completion event');
});

// Test multi-step task with tool usage
test.serial('sys_entity_agent handles multi-step task with tools', async (t) => {
  t.timeout(60000); // 60 second timeout for multi-step task
  const response = await testServer.executeOperation({
    query: `
      query TestAgentMultiStep(
        $text: String!, 
        $chatHistory: [MultiMessage]!
      ) {
        sys_entity_agent(
          text: $text, 
          chatHistory: $chatHistory,
          stream: true
        ) {
          result
          contextId
          tool
          warnings
          errors
        }
      }
    `,
    variables: {
      text: 'Research the latest developments in renewable energy and summarize the key trends.',
      chatHistory: [{
        role: "user",
        content: ["Research the latest developments in renewable energy and summarize the key trends."]
      }]
    }
  });

  console.log('Multi-step Agent Response:', JSON.stringify(response, null, 2));

  // Check for successful response
  t.falsy(response.body?.singleResult?.errors, 'Should not have GraphQL errors');
  const requestId = response.body?.singleResult?.data?.sys_entity_agent?.result;
  t.truthy(requestId, 'Should have a requestId in the result field');

  // Collect events with a longer timeout since this is a multi-step operation
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
  }, 60000);

  console.log(`Received ${events.length} events for multi-step task`);
  t.true(events.length > 0, 'Should have received events');

  // Verify we got a completion event
  const completionEvent = events.find(event =>
    event.data.requestProgress.progress === 1
  );
  t.truthy(completionEvent, 'Should have received a completion event');

  // Check for tool usage in the events
  let foundToolUsage = false;
  for (const event of events) {
    if (event.data.requestProgress.info) {
      try {
        const info = JSON.parse(event.data.requestProgress.info);
        if (info.toolUsed) {
          foundToolUsage = true;
          break;
        }
      } catch (e) {
        // Some info might not be JSON, which is fine
      }
    }
  }
  t.true(foundToolUsage, 'Should have used tools during execution');
});