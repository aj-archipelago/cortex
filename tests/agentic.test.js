// agentic.test.js
// Tests for the agentic entity system

import test from 'ava';
import serverFactory from '../index.js';
import { createClient } from 'graphql-ws';
import ws from 'ws';

// Define models to test - 4.1 as default, include grok 4
const TEST_MODELS = [
  'oai-gpt41',  // Default 4.1 model
  'xai-grok-4'  // Grok 4 model
];

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

// Helper function to create model-specific tests
function createModelTest(testName, testFunction) {
  TEST_MODELS.forEach(model => {
    test.serial(`${testName} - ${model}`, async (t) => {
      await testFunction(t, model);
    });
  });
}

// Helper function to validate info object structure
function validateInfoObject(t, info, testName) {
  if (!info || typeof info !== 'object') {
    t.fail(`${testName}: Info object should be a valid object`);
    return;
  }

  // Check if info object has any meaningful content
  const hasContent = Object.keys(info).length > 0;
  t.true(hasContent, `${testName}: Info object should have some content`);

  // Validate toolUsed if present
  if (info.toolUsed) {
    if (Array.isArray(info.toolUsed)) {
      t.true(info.toolUsed.length > 0, `${testName}: toolUsed array should not be empty`);
      info.toolUsed.forEach((tool, index) => {
        // Handle nested arrays in toolUsed
        if (Array.isArray(tool)) {
          t.true(tool.length > 0, `${testName}: toolUsed[${index}] nested array should not be empty`);
          tool.forEach((nestedTool, nestedIndex) => {
            t.true(typeof nestedTool === 'string', `${testName}: toolUsed[${index}][${nestedIndex}] should be a string`);
            t.truthy(nestedTool.trim(), `${testName}: toolUsed[${index}][${nestedIndex}] should not be empty`);
          });
        } else {
          t.true(typeof tool === 'string', `${testName}: toolUsed[${index}] should be a string`);
          t.truthy(tool.trim(), `${testName}: toolUsed[${index}] should not be empty`);
        }
      });
    } else {
      t.true(typeof info.toolUsed === 'string', `${testName}: toolUsed should be a string if not array`);
      t.truthy(info.toolUsed.trim(), `${testName}: toolUsed should not be empty`);
    }
  }

  // Validate citations if present
  if (info.citations) {
    t.true(Array.isArray(info.citations), `${testName}: citations should be an array`);
    info.citations.forEach((citation, index) => {
      t.true(typeof citation === 'object', `${testName}: citations[${index}] should be an object`);
      if (citation.title) {
        t.true(typeof citation.title === 'string', `${testName}: citations[${index}].title should be a string`);
      }
      if (citation.url) {
        t.true(typeof citation.url === 'string', `${testName}: citations[${index}].url should be a string`);
        // URLs can be empty strings, which is valid
        if (citation.url.trim()) {
          t.true(citation.url.startsWith('http'), `${testName}: citations[${index}].url should be a valid URL if not empty`);
        }
      }
      if (citation.content) {
        t.true(typeof citation.content === 'string', `${testName}: citations[${index}].content should be a string`);
      }
    });
  }

  // Validate toolCalls if present
  if (info.toolCalls) {
    t.true(Array.isArray(info.toolCalls), `${testName}: toolCalls should be an array`);
    info.toolCalls.forEach((toolCall, index) => {
      t.true(typeof toolCall === 'object', `${testName}: toolCalls[${index}] should be an object`);
      if (toolCall.name) {
        t.true(typeof toolCall.name === 'string', `${testName}: toolCalls[${index}].name should be a string`);
      }
    });
  }

  // Validate usage if present
  if (info.usage) {
    // Handle both single usage object and array of usage objects
    if (Array.isArray(info.usage)) {
      t.true(info.usage.length > 0, `${testName}: usage array should not be empty`);
      info.usage.forEach((usage, index) => {
        t.true(typeof usage === 'object', `${testName}: usage[${index}] should be an object`);
        if (usage.prompt_tokens !== undefined) {
          t.true(typeof usage.prompt_tokens === 'number', `${testName}: usage[${index}].prompt_tokens should be a number`);
        }
        if (usage.completion_tokens !== undefined) {
          t.true(typeof usage.completion_tokens === 'number', `${testName}: usage[${index}].completion_tokens should be a number`);
        }
        if (usage.total_tokens !== undefined) {
          t.true(typeof usage.total_tokens === 'number', `${testName}: usage[${index}].total_tokens should be a number`);
        }
      });
    } else {
      t.true(typeof info.usage === 'object', `${testName}: usage should be an object`);
      if (info.usage.prompt_tokens !== undefined) {
        t.true(typeof info.usage.prompt_tokens === 'number', `${testName}: usage.prompt_tokens should be a number`);
      }
      if (info.usage.completion_tokens !== undefined) {
        t.true(typeof info.usage.completion_tokens === 'number', `${testName}: usage.completion_tokens should be a number`);
      }
      if (info.usage.total_tokens !== undefined) {
        t.true(typeof info.usage.total_tokens === 'number', `${testName}: usage.total_tokens should be a number`);
      }
    }
  }

  // Validate finishReason if present
  if (info.finishReason) {
    t.true(typeof info.finishReason === 'string', `${testName}: finishReason should be a string`);
    const validReasons = ['stop', 'length', 'tool_calls', 'content_filter', 'function_call'];
    t.true(validReasons.includes(info.finishReason), `${testName}: finishReason should be a valid reason`);
  }
}

// Helper function to flatten nested arrays
function flattenArray(arr) {
  const result = [];
  for (const item of arr) {
    if (Array.isArray(item)) {
      result.push(...flattenArray(item));
    } else {
      result.push(item);
    }
  }
  return result;
}

// Test basic single-step task
createModelTest('sys_entity_agent handles single-step task', async (t, model) => {
  t.timeout(60000); // 60 second timeout
  const response = await testServer.executeOperation({
    query: `
      query TestAgentSingleStep(
        $text: String!, 
        $chatHistory: [MultiMessage]!,
        $model: String
      ) {
        sys_entity_agent(
          text: $text, 
          chatHistory: $chatHistory,
          model: $model,
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
      text: 'What is the current time in Los Angeles?',
      chatHistory: [{ 
        role: "user", 
        content: ["What is the current time in Los Angeles?"] 
      }],
      model: model
    }
  });

  console.log(`Single-step Agent Response (${model}):`, JSON.stringify(response, null, 2));
  
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

  console.log(`Received ${events.length} events for single-step task (${model})`);
  t.true(events.length > 0, 'Should have received events');

  // Verify we got a completion event
  const completionEvent = events.find(event =>
    event.data.requestProgress.progress === 1
  );
  t.truthy(completionEvent, 'Should have received a completion event');

  // Validate the info object in the completion event
  const infoString = completionEvent.data.requestProgress.info;
  
  // For single-step tasks, info might be empty or an empty object, which is acceptable
  if (infoString && infoString.trim()) {
    let infoObject;
    try {
      infoObject = JSON.parse(infoString);
    } catch (error) {
      t.fail(`Failed to parse info object: ${error.message}`);
      return;
    }

    // Validate the info object structure
    if (Object.keys(infoObject).length > 0) {
      validateInfoObject(t, infoObject, 'Single-step task');
    }

    // For single-step tasks, we might not have tool usage, but we should have other properties
    if (infoObject.finishReason) {
      t.true(['stop', 'length', 'tool_calls', 'content_filter'].includes(infoObject.finishReason), 
        'Single-step task should have a valid finish reason');
    }
    console.log(`Single-step info object validation passed for ${model}:`, JSON.stringify(infoObject, null, 2));
  } else {
    console.log(`Single-step task (${model}) completed without info object - this is acceptable for simple tasks`);
  }
});

// Test multi-step task with tool usage
createModelTest('sys_entity_agent handles multi-step task with tools', async (t, model) => {
  t.timeout(360000); // 120 second timeout for multi-step task
  const response = await testServer.executeOperation({
    query: `
      query TestAgentMultiStep(
        $text: String!, 
        $chatHistory: [MultiMessage]!,
        $model: String
      ) {
        sys_entity_agent(
          text: $text, 
          chatHistory: $chatHistory,
          model: $model,
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
      }],
      model: model
    }
  });

  console.log(`Multi-step Agent Response (${model}):`, JSON.stringify(response, null, 2));
  
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
  }, 240000);

  console.log(`Received ${events.length} events for multi-step task (${model})`);
  t.true(events.length > 0, 'Should have received events');

  // Verify we got a completion event
  const completionEvent = events.find(event =>
    event.data.requestProgress.progress === 1
  );
  t.truthy(completionEvent, 'Should have received a completion event');

  const infoString = completionEvent.data.requestProgress.info;
  t.truthy(infoString, 'Multi-step task should have info object');
  
  let infoObject;
  try {
    infoObject = JSON.parse(infoString);
  } catch (error) {
    t.fail(`Failed to parse info object: ${error.message}`);
    return;
  }

  // Validate the info object structure
  validateInfoObject(t, infoObject, 'Multi-step task');

  // Additional specific validations for multi-step tasks
  if (infoObject.toolUsed) {
    // For multi-step tasks, we expect multiple tools to be used
    const toolUsedArray = Array.isArray(infoObject.toolUsed) ? infoObject.toolUsed : [infoObject.toolUsed];
    t.true(toolUsedArray.length > 0, 'Multi-step task should have used at least one tool');
    
    // Flatten nested arrays for tool counting
    const flattenedTools = flattenArray(toolUsedArray);
    t.true(flattenedTools.length > 0, 'Multi-step task should have used tools after flattening');
    
    // Check for common tool types that should be used in research tasks
    const expectedToolTypes = ['Search', 'SearchInternetAgent2', 'SearchXPlatform', 'WebPageContent', 'SearchAgent'];
    const hasExpectedTool = flattenedTools.some(tool => 
      expectedToolTypes.some(expectedType => tool.includes(expectedType))
    );
    t.true(hasExpectedTool, 'Multi-step research task should have used search tools');
  }

  // Validate citations for research tasks
  if (infoObject.citations) {
    t.true(infoObject.citations.length > 0, 'Research task should have citations');
    infoObject.citations.forEach((citation, index) => {
      // Citations should have either URL or content, but not necessarily both
      t.truthy(citation.url || citation.content, `Citation ${index} should have URL or content`);
      if (citation.title || citation.content) {
        t.truthy(citation.title || citation.content, `Citation ${index} should have title or content`);
      }
    });
  }

  // Validate toolCalls for multi-step tasks
  if (infoObject.toolCalls) {
    t.true(infoObject.toolCalls.length > 0, 'Multi-step task should have tool calls');
  }

  // Validate usage statistics
  if (infoObject.usage) {
    // Handle both single usage object and array of usage objects
    if (Array.isArray(infoObject.usage)) {
      t.true(infoObject.usage.length > 0, 'Multi-step task should have usage data');
      const latestUsage = infoObject.usage[0]; // Most recent usage first
      t.truthy(latestUsage.total_tokens, 'Multi-step task should have total token usage');
      t.true(latestUsage.total_tokens > 0, 'Multi-step task should have used tokens');
    } else {
      t.truthy(infoObject.usage.total_tokens, 'Multi-step task should have total token usage');
      t.true(infoObject.usage.total_tokens > 0, 'Multi-step task should have used tokens');
    }
  }

  // Validate finish reason
  if (infoObject.finishReason) {
    t.true(['stop', 'length', 'tool_calls', 'content_filter'].includes(infoObject.finishReason), 
      'Multi-step task should have a valid finish reason');
  }

  console.log(`Multi-step info object validation passed for ${model}:`, JSON.stringify(infoObject, null, 2));
});
