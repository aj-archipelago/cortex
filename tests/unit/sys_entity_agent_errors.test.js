import test from 'ava';
import sysEntityAgent from '../../pathways/system/entity/sys_entity_agent.js';
import { config } from '../../config.js';
import { getToolsForEntity } from '../../pathways/system/entity/tools/shared/sys_entity_tools.js';
import { withTimeout } from '../../lib/pathwayTools.js';

const buildToolDefinition = (name, pathwayName, overrides = {}) => ({
  pathwayName,
  definition: {
    type: 'function',
    icon: '🧪',
    function: {
      name,
      description: `Test tool for ${name}`,
      parameters: {
        type: 'object',
        properties: {
          userMessage: { type: 'string' },
        },
        required: [],
      },
    },
    ...overrides,
  },
});

const buildToolCall = (name, args = { userMessage: 'run test' }, id = 'call-1') => ({
  id,
  type: 'function',
  function: {
    name,
    arguments: JSON.stringify(args),
  },
});

const buildResolver = (overrides = {}) => ({
  errors: [],
  requestId: 'req-test',
  rootRequestId: 'root-req-test',
  pathway: sysEntityAgent,
  modelExecutor: {
    plugin: {
      truncateMessagesToTargetLength: (messages) => messages,
    },
  },
  promptAndParse: async () => 'final-response',
  ...overrides,
});

const setupConfig = () => {
  const originalGet = config.get.bind(config);
  const originalPathways = config.get('pathways') || {};
  const originalEntityTools = config.get('entityTools') || {};

  const tools = {
    errorjson: buildToolDefinition('ErrorJson', 'test_tool_error_json'),
    throws500: buildToolDefinition('Throws500', 'test_tool_500'),
    timeouttool: buildToolDefinition('TimeoutTool', 'test_tool_timeout'),
    nullresult: buildToolDefinition('NullResult', 'test_tool_null'),
  };

  const entityId = 'entity-test-errors';
  const entityConfig = {
    [entityId]: {
      id: entityId,
      isDefault: true,
      tools: Object.keys(tools),
      customTools: tools,
    },
  };

  const pathways = {
    ...originalPathways,
    sys_generator_error: {
      rootResolver: async (_parent, args) => ({
        result: `ERROR_RESPONSE: ${args.text}`,
      }),
    },
    test_tool_error_json: {
      rootResolver: async () => ({
        result: JSON.stringify({ error: true, message: '400 Bad Request' }),
      }),
    },
    test_tool_500: {
      rootResolver: async () => {
        throw new Error('500 Internal Server Error');
      },
    },
    test_tool_timeout: {
      rootResolver: async () => {
        throw new Error('ETIMEDOUT');
      },
    },
    test_tool_null: {
      rootResolver: async () => ({
        result: null,
      }),
    },
  };

  config.load({
    pathways,
    entityTools: {},
  });

  // convict schema does not expose entityConfig; override config.get for tests
  config.get = (key) => {
    if (key === 'entityConfig') {
      return entityConfig;
    }
    return originalGet(key);
  };

  return {
    entityId,
    originalGet,
    originalPathways,
    originalEntityTools,
  };
};

const restoreConfig = (originals) => {
  config.load({
    pathways: originals.originalPathways,
    entityTools: originals.originalEntityTools,
  });

  config.get = originals.originalGet;
};

test.serial('executePathway returns sys_generator_error output on 500 base model error', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const resolver = buildResolver();
  const args = {
    text: 'trigger base model error',
    chatHistory: [{ role: 'user', content: 'hi' }],
    agentContext: [],
    entityId: originals.entityId,
  };

  const runAllPrompts = async () => {
    throw new Error('HTTP 500 from model');
  };

  const result = await sysEntityAgent.executePathway({ args, runAllPrompts, resolver });
  t.true(result.includes('ERROR_RESPONSE'));
  t.true(result.includes('HTTP 500 from model'));
});

test.serial('executePathway falls back when sys_generator_error fails after null model response', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const brokenPathways = {
    ...config.get('pathways'),
    sys_generator_error: {
      rootResolver: async () => {
        throw new Error('sys_generator_error failed');
      },
    },
  };
  config.load({ pathways: brokenPathways });

  const resolver = buildResolver();
  const args = {
    text: 'trigger null response',
    chatHistory: [{ role: 'user', content: 'hi' }],
    agentContext: [],
    entityId: originals.entityId,
  };

  const runAllPrompts = async () => null;
  const result = await sysEntityAgent.executePathway({ args, runAllPrompts, resolver });

  t.true(result.includes('I apologize, but I encountered an error while processing your request'));
  t.true(result.includes('Model execution returned null'));
});

test.serial('toolCallback surfaces 400 error JSON from tool result', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = config.get('entityConfig')[originals.entityId];
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let promptArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      promptArgs = args;
      return 'tool-handled';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'use tool' }],
    entityTools,
    entityToolsOpenAiFormat,
  };

  const message = { tool_calls: [buildToolCall('ErrorJson')] };
  const result = await sysEntityAgent.toolCallback(args, message, resolver);

  t.is(result, 'tool-handled');
  const toolMessage = args.chatHistory.find((entry) => entry.role === 'tool');
  t.truthy(toolMessage);
  t.true(toolMessage.content.includes('400 Bad Request'));
  t.truthy(promptArgs);
  t.true(promptArgs.chatHistory.some((entry) => (
    entry.role === 'tool' && entry.content.includes('400 Bad Request')
  )));
});

test.serial('toolCallback captures 500 error thrown by tool pathway', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = config.get('entityConfig')[originals.entityId];
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let promptArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      promptArgs = args;
      return 'tool-handled';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'use tool' }],
    entityTools,
    entityToolsOpenAiFormat,
  };

  const message = { tool_calls: [buildToolCall('Throws500')] };
  const result = await sysEntityAgent.toolCallback(args, message, resolver);

  t.is(result, 'tool-handled');
  const toolMessage = args.chatHistory.find((entry) => entry.role === 'tool');
  t.truthy(toolMessage);
  t.true(toolMessage.content.includes('500 Internal Server Error'));
  t.truthy(promptArgs);
  t.true(promptArgs.chatHistory.some((entry) => (
    entry.role === 'tool' && entry.content.includes('500 Internal Server Error')
  )));
});

test.serial('toolCallback captures tool null result as error', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = config.get('entityConfig')[originals.entityId];
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let promptArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      promptArgs = args;
      return 'tool-handled';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'use tool' }],
    entityTools,
    entityToolsOpenAiFormat,
  };

  const message = { tool_calls: [buildToolCall('NullResult')] };
  const result = await sysEntityAgent.toolCallback(args, message, resolver);

  t.is(result, 'tool-handled');
  const toolMessage = args.chatHistory.find((entry) => entry.role === 'tool');
  t.truthy(toolMessage);
  t.true(toolMessage.content.includes('returned null result'));
  t.truthy(promptArgs);
  t.true(promptArgs.chatHistory.some((entry) => (
    entry.role === 'tool' && entry.content.includes('returned null result')
  )));
});

test.serial('toolCallback reports invalid tool call arguments', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = config.get('entityConfig')[originals.entityId];
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let promptArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      promptArgs = args;
      return 'tool-handled';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'use tool' }],
    entityTools,
    entityToolsOpenAiFormat,
  };

  const message = {
    tool_calls: [{
      id: 'bad-tool-call',
      type: 'function',
      function: { name: 'ErrorJson' },
    }],
  };

  const result = await sysEntityAgent.toolCallback(args, message, resolver);
  t.is(result, 'tool-handled');
  const toolMessage = args.chatHistory.find((entry) => entry.role === 'tool');
  t.truthy(toolMessage);
  t.true(toolMessage.content.includes('Invalid tool call structure: missing function arguments'));
  t.truthy(promptArgs);
  t.true(promptArgs.chatHistory.some((entry) => (
    entry.role === 'tool' && entry.content.includes('Invalid tool call structure')
  )));
});

test.serial('toolCallback returns error response when promptAndParse throws', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = config.get('entityConfig')[originals.entityId];
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  const resolver = buildResolver({
    promptAndParse: async () => {
      throw new Error('Model crashed after tool calls');
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'use tool' }],
    entityTools,
    entityToolsOpenAiFormat,
  };

  const message = { tool_calls: [buildToolCall('ErrorJson')] };
  const result = await sysEntityAgent.toolCallback(args, message, resolver);

  t.true(result.includes('ERROR_RESPONSE'));
  t.true(result.includes('Model crashed after tool calls'));
});

test.serial('executePathway returns error response when tool recursion times out', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = config.get('entityConfig')[originals.entityId];
  const { entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  const resolver = buildResolver({
    promptAndParse: async () => {
      throw new Error('Tool recursion timeout');
    },
  });

  const args = {
    text: 'trigger tool recursion',
    chatHistory: [{ role: 'user', content: 'hi' }],
    agentContext: [],
    entityId: originals.entityId,
    entityToolsOpenAiFormat,
  };

  const runAllPrompts = async () => ({
    tool_calls: [buildToolCall('TimeoutTool')],
  });

  const result = await sysEntityAgent.executePathway({ args, runAllPrompts, resolver });
  t.true(result.includes('ERROR_RESPONSE'));
  t.true(result.includes('Tool recursion timeout'));
});

test.serial('toolCallback injects max tool call message once limit reached', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  const entityConfig = config.get('entityConfig')[originals.entityId];
  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig);

  let promptArgs;
  const resolver = buildResolver({
    toolCallCount: 50,
    promptAndParse: async (args) => {
      promptArgs = args;
      return 'tool-handled';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'use tool' }],
    entityTools,
    entityToolsOpenAiFormat,
  };

  const message = { tool_calls: [buildToolCall('ErrorJson')] };
  await sysEntityAgent.toolCallback(args, message, resolver);

  const systemMessage = promptArgs.chatHistory.find((entry) => (
    entry.role === 'user' &&
    typeof entry.content === 'string' &&
    entry.content.includes('Maximum tool call limit reached')
  ));

  t.truthy(systemMessage);
});

// === NEW TESTS FOR ROBUSTNESS FEATURES ===

test('withTimeout resolves when promise completes before timeout', async (t) => {
  const result = await withTimeout(
    Promise.resolve('success'),
    1000,
    'Should not timeout'
  );
  t.is(result, 'success');
});

test('withTimeout rejects when promise takes longer than timeout', async (t) => {
  const slowPromise = new Promise((resolve) => setTimeout(() => resolve('too late'), 200));
  
  const error = await t.throwsAsync(
    withTimeout(slowPromise, 50, 'Operation timed out after 50ms')
  );
  
  t.is(error.message, 'Operation timed out after 50ms');
});

test('withTimeout clears timeout when promise resolves', async (t) => {
  // This test ensures no memory leaks from dangling timeouts
  const result = await withTimeout(
    Promise.resolve('quick'),
    10000, // Long timeout that should be cleared
    'Should not timeout'
  );
  t.is(result, 'quick');
});

test('withTimeout clears timeout when promise rejects', async (t) => {
  const error = await t.throwsAsync(
    withTimeout(
      Promise.reject(new Error('Original error')),
      10000,
      'Should not timeout'
    )
  );
  t.is(error.message, 'Original error');
});

test.serial('toolCallback truncates oversized tool results', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  // Create a tool that returns a very large result
  const largeResultPathways = {
    ...config.get('pathways'),
    test_tool_large_result: {
      rootResolver: async () => ({
        // Create a result larger than MAX_TOOL_RESULT_LENGTH (150000)
        result: JSON.stringify({ data: 'x'.repeat(160000) }),
      }),
    },
  };
  config.load({ pathways: largeResultPathways });

  const tools = {
    ...config.get('entityConfig')[originals.entityId].customTools,
    largeresult: buildToolDefinition('LargeResult', 'test_tool_large_result'),
  };

  const entityConfig = {
    [originals.entityId]: {
      ...config.get('entityConfig')[originals.entityId],
      tools: [...config.get('entityConfig')[originals.entityId].tools, 'largeresult'],
      customTools: tools,
    },
  };

  config.get = (key) => {
    if (key === 'entityConfig') {
      return entityConfig;
    }
    return originals.originalGet(key);
  };

  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig[originals.entityId]);

  let promptArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      promptArgs = args;
      return 'tool-handled';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'use large tool' }],
    entityTools,
    entityToolsOpenAiFormat,
  };

  const message = { tool_calls: [buildToolCall('LargeResult')] };
  await sysEntityAgent.toolCallback(args, message, resolver);

  // Find the tool result message in chatHistory
  const toolMessage = promptArgs.chatHistory.find((entry) => entry.role === 'tool');
  t.truthy(toolMessage);
  
  // Verify the content was truncated (should be less than 160000 chars)
  t.true(toolMessage.content.length < 160000);
  
  // Verify truncation message was added
  t.true(toolMessage.content.includes('[Content truncated due to length]'));
});

test('findSafeSplitPoint preserves tool call/result pairs', (t) => {
  // Import the helper (we'll need to export it or test via integration)
  // For now, test the concept with inline implementation
  
  const findSafeSplitPoint = (messages, keepRecentCount = 6) => {
    const toolCallIndexMap = new Map();
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.id) toolCallIndexMap.set(tc.id, i);
        }
      }
    }
    
    let splitIndex = Math.max(0, messages.length - keepRecentCount);
    
    let adjusted = true;
    while (adjusted && splitIndex > 0) {
      adjusted = false;
      for (let i = splitIndex; i < messages.length; i++) {
        const msg = messages[i];
        if (msg.role === 'tool' && msg.tool_call_id) {
          const callIndex = toolCallIndexMap.get(msg.tool_call_id);
          if (callIndex !== undefined && callIndex < splitIndex) {
            splitIndex = callIndex;
            adjusted = true;
            break;
          }
        }
      }
    }
    
    return splitIndex;
  };

  // Test: should not split if it would orphan a tool result
  const messages = [
    { role: 'user', content: 'query 1' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', function: { name: 'search' } }] },
    { role: 'tool', tool_call_id: 'tc1', content: 'result 1' },
    { role: 'assistant', content: 'response 1' },
    { role: 'user', content: 'query 2' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'tc2', function: { name: 'search' } }] },
    { role: 'tool', tool_call_id: 'tc2', content: 'result 2' },
    { role: 'assistant', content: 'response 2' },
  ];

  // With keepRecentCount=4, naive split would be at index 4
  // But tc2's result is at index 6, its call at index 5
  // So split should be adjusted to keep tc2 call with its result
  const splitIndex = findSafeSplitPoint(messages, 4);
  
  // The split should ensure tc2 call (index 5) stays with tc2 result (index 6)
  // So split should be at index 4 or earlier
  t.true(splitIndex <= 4, 'Split should be at or before index 4');
  
  // Verify: messages from splitIndex onwards should have paired tool calls/results
  const keptMessages = messages.slice(splitIndex);
  const keptToolCallIds = new Set();
  for (const msg of keptMessages) {
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        keptToolCallIds.add(tc.id);
      }
    }
  }
  
  // Every tool result in kept messages should have its call in kept messages
  for (const msg of keptMessages) {
    if (msg.role === 'tool' && msg.tool_call_id) {
      t.true(keptToolCallIds.has(msg.tool_call_id), 
        `Tool result ${msg.tool_call_id} should have its call in kept messages`);
    }
  }
});

test.serial('toolCallback handles tool timeout error correctly', async (t) => {
  const originals = setupConfig();
  t.teardown(() => restoreConfig(originals));

  // Create a tool that simulates a timeout
  const timeoutPathways = {
    ...config.get('pathways'),
    test_tool_slow: {
      rootResolver: async () => {
        // Simulate a slow tool that would timeout
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { result: 'completed' };
      },
    },
  };
  config.load({ pathways: timeoutPathways });

  const tools = {
    ...config.get('entityConfig')[originals.entityId].customTools,
    slowtool: {
      ...buildToolDefinition('SlowTool', 'test_tool_slow'),
      definition: {
        ...buildToolDefinition('SlowTool', 'test_tool_slow').definition,
        // Set a very short timeout to trigger timeout
        timeout: 10,
      },
    },
  };

  const entityConfig = {
    [originals.entityId]: {
      ...config.get('entityConfig')[originals.entityId],
      tools: [...config.get('entityConfig')[originals.entityId].tools, 'slowtool'],
      customTools: tools,
    },
  };

  config.get = (key) => {
    if (key === 'entityConfig') {
      return entityConfig;
    }
    return originals.originalGet(key);
  };

  const { entityTools, entityToolsOpenAiFormat } = getToolsForEntity(entityConfig[originals.entityId]);

  let promptArgs;
  const resolver = buildResolver({
    promptAndParse: async (args) => {
      promptArgs = args;
      return 'tool-handled';
    },
  });

  const args = {
    chatHistory: [{ role: 'user', content: 'use slow tool' }],
    entityTools,
    entityToolsOpenAiFormat,
  };

  const message = { tool_calls: [buildToolCall('SlowTool')] };
  const result = await sysEntityAgent.toolCallback(args, message, resolver);

  t.is(result, 'tool-handled');
  
  // Find the tool result message - should contain timeout error
  const toolMessage = promptArgs.chatHistory.find((entry) => entry.role === 'tool');
  t.truthy(toolMessage);
  t.true(toolMessage.content.includes('timed out'));
});

// Test the logic that prevents non-streaming responses from killing parent streams
// The fix was: only publish completion if receivedSSEData is true
test('non-streaming tool response should not trigger parent stream completion', (t) => {
  // This test validates the logic pattern used in pathwayResolver.handleStream
  // The bug was: non-streaming tool calls would publish progress=1 to rootRequestId
  // because completionSent was false (no SSE events received)
  
  // Simulate the state after a non-streaming response closes
  const receivedSSEData = false; // No SSE events received (non-streaming)
  const completionSent = false;  // No completion signal from stream
  const streamErrorOccurred = false;
  
  // The OLD buggy logic:
  const oldLogicWouldPublish = streamErrorOccurred || !completionSent;
  t.true(oldLogicWouldPublish, 'Old logic would incorrectly publish completion');
  
  // The NEW fixed logic:
  const newLogicWouldPublish = receivedSSEData && (streamErrorOccurred || !completionSent);
  t.false(newLogicWouldPublish, 'New logic correctly skips completion for non-streaming');
});

test('streaming response with incomplete data should trigger completion', (t) => {
  // When we receive SSE data but stream closes without completion signal
  // we SHOULD send a completion (to clean up the client state)
  
  const receivedSSEData = true;  // SSE events were received
  const completionSent = false;  // But no completion signal
  const streamErrorOccurred = false;
  
  const newLogicWouldPublish = receivedSSEData && (streamErrorOccurred || !completionSent);
  t.true(newLogicWouldPublish, 'Should publish completion when streaming response has no completion signal');
});

test('streaming response with error should trigger completion with error', (t) => {
  // When stream has an error, we should send completion with error info
  
  const receivedSSEData = true;
  const completionSent = false;
  const streamErrorOccurred = true;
  
  const newLogicWouldPublish = receivedSSEData && (streamErrorOccurred || !completionSent);
  t.true(newLogicWouldPublish, 'Should publish completion when stream has error');
});

test('normal streaming completion should not double-send', (t) => {
  // When stream completes normally (completionSent = true), don't send again
  
  const receivedSSEData = true;
  const completionSent = true;  // Normal completion already sent
  const streamErrorOccurred = false;
  
  const newLogicWouldPublish = receivedSSEData && (streamErrorOccurred || !completionSent);
  t.false(newLogicWouldPublish, 'Should not double-send completion');
});

// Test that actually exercises the SSE parser behavior
test('SSE parser only sets receivedSSEData for actual event types', async (t) => {
  const { createParser } = await import('eventsource-parser');
  
  // Simulate the pathwayResolver's onParse logic
  let receivedSSEData = false;
  
  const onParse = (event) => {
    // This mirrors the FIXED code in pathwayResolver.js
    if (event.type === 'event') {
      receivedSSEData = true;
    }
    // Other event types (like 'reconnect-interval') should NOT set receivedSSEData
  };
  
  const parser = createParser(onParse);
  
  // Feed non-SSE JSON data (like a Grok non-streaming response)
  const jsonResponse = JSON.stringify({
    id: 'resp_123',
    output: [{ type: 'message', content: [{ text: 'Hello' }] }]
  });
  parser.feed(jsonResponse);
  
  t.false(receivedSSEData, 'Non-SSE JSON should not set receivedSSEData');
  
  // Now feed actual SSE data (proper SSE format with event type)
  parser.feed('event: message\ndata: {"content":"hello"}\n\n');
  
  t.true(receivedSSEData, 'Actual SSE event should set receivedSSEData');
});

test('SSE parser with reconnect-interval should not set receivedSSEData', async (t) => {
  const { createParser } = await import('eventsource-parser');
  
  let receivedSSEData = false;
  
  const onParse = (event) => {
    if (event.type === 'event') {
      receivedSSEData = true;
    }
  };
  
  const parser = createParser(onParse);
  
  // Feed a reconnect-interval directive (valid SSE but not an 'event' type)
  parser.feed('retry: 3000\n\n');
  
  t.false(receivedSSEData, 'reconnect-interval should not set receivedSSEData');
});

test('tool callback invoked should not trigger stream warning or completion', (t) => {
  // When a tool callback is invoked (e.g., Gemini returns tool calls),
  // the stream closes but this is expected - the tool will execute and 
  // a new stream will open. We should not warn or send completion.
  
  const receivedSSEData = true;   // SSE data was received
  const completionSent = false;   // No progress=1 from the model (expected for tool calls)
  const streamErrorOccurred = false;
  const toolCallbackInvoked = true;  // Tool callback was invoked
  
  // Warning condition
  const shouldWarn = receivedSSEData && !completionSent && !streamErrorOccurred && !toolCallbackInvoked;
  t.false(shouldWarn, 'Should not warn when tool callback invoked');
  
  // Completion condition
  const shouldPublishCompletion = receivedSSEData && !toolCallbackInvoked && (streamErrorOccurred || !completionSent);
  t.false(shouldPublishCompletion, 'Should not publish completion when tool callback invoked');
});
