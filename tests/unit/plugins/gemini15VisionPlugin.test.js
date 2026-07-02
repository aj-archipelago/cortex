import test from 'ava';
import Gemini15VisionPlugin from '../../../server/plugins/gemini15VisionPlugin.js';
import { requestState } from '../../../server/requestState.js';

const createPlugin = () => {
  const pathway = {
    name: 'test-pathway',
    model: 'gemini-flash-35-vision',
    prompt: 'test prompt',
    toolCallback: () => {}
  };

  const model = {
    name: 'gemini-flash-35-vision',
    type: 'GEMINI-3-REASONING-VISION'
  };

  return new Gemini15VisionPlugin(pathway, model);
};

const findArrayTypePaths = (schema, path = '$') => {
  if (!schema || typeof schema !== 'object') {
    return [];
  }

  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) => findArrayTypePaths(item, `${path}[${index}]`));
  }

  const findings = [];
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'type' && Array.isArray(value)) {
      findings.push(`${path}.type`);
      continue;
    }

    findings.push(...findArrayTypePaths(value, `${path}.${key}`));
  }

  return findings;
};

test('Gemini15VisionPlugin - sanitizes tool schema fields for Gemini', t => {
  const plugin = createPlugin();
  const openAiTools = [
    {
      type: 'function',
      function: {
        name: 'doThing',
        description: 'Test tool',
        parameters: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          propertyNames: { pattern: '^[a-z]+$' },
          properties: {
            mode: { const: 'fast' },
            count: { type: 'integer', exclusiveMinimum: 0 },
            size: { type: 'integer', exclusiveMaximum: 10 },
            level: { type: 'string', enum: [1, 'ok'] }
          },
          required: ['mode']
        }
      }
    }
  ];

  const converted = plugin.convertOpenAIToolsToGemini(openAiTools);
  t.is(converted.length, 1);
  t.is(converted[0].functionDeclarations.length, 1);

  const params = converted[0].functionDeclarations[0].parameters;
  t.falsy(params.$schema);
  t.falsy(params.propertyNames);
  t.deepEqual(params.properties.mode.enum, ['fast']);
  t.is(params.properties.count.minimum, 0);
  t.falsy(params.properties.count.exclusiveMinimum);
  t.is(params.properties.size.maximum, 10);
  t.falsy(params.properties.size.exclusiveMaximum);
  t.deepEqual(params.properties.level.enum, ['1', 'ok']);
});

test('Gemini15VisionPlugin - normalizes nullable type tuples to nullable flag', t => {
  const plugin = createPlugin();
  const openAiTools = [
    {
      type: 'function',
      function: {
        name: 'GetApplets',
        description: 'Read applets',
        parameters: {
          type: 'object',
          properties: {
            appletId: { type: ['string', 'null'], description: 'optional id' },
            version: { type: ['number', 'null'], description: 'optional version' },
            tags: {
              type: ['array', 'null'],
              items: { type: 'string' }
            },
            name: { type: 'string' }
          },
          required: []
        }
      }
    }
  ];

  const params = plugin.convertOpenAIToolsToGemini(openAiTools)[0]
    .functionDeclarations[0].parameters;

  t.is(params.properties.appletId.type, 'string');
  t.true(params.properties.appletId.nullable);

  t.is(params.properties.version.type, 'number');
  t.true(params.properties.version.nullable);

  t.is(params.properties.tags.type, 'array');
  t.true(params.properties.tags.nullable);
  t.is(params.properties.tags.items.type, 'string');

  // Non-nullable strings should be untouched
  t.is(params.properties.name.type, 'string');
  t.falsy(params.properties.name.nullable);
});

test('Gemini15VisionPlugin - converts multi-type arrays to Gemini anyOf', t => {
  const plugin = createPlugin();
  const openAiTools = [
    {
      type: 'function',
      function: {
        name: 'CreateApplet',
        description: 'Create an applet',
        parameters: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            createNew: {
              type: ['boolean', 'string'],
              description: 'Create a separate applet when true or createNew'
            },
            mode: {
              type: ['string', 'boolean', 'null'],
              description: 'Legacy multi-type nullable parameter'
            }
          },
          required: ['prompt']
        }
      }
    }
  ];

  const params = plugin.convertOpenAIToolsToGemini(openAiTools)[0]
    .functionDeclarations[0].parameters;

  t.falsy(params.properties.createNew.type);
  t.deepEqual(params.properties.createNew.anyOf, [
    { type: 'boolean' },
    { type: 'string' }
  ]);

  t.falsy(params.properties.mode.type);
  t.true(params.properties.mode.nullable);
  t.deepEqual(params.properties.mode.anyOf, [
    { type: 'string' },
    { type: 'boolean' }
  ]);

  t.deepEqual(findArrayTypePaths(params), []);
});

test('convertMessagesToGemini converts assistant tool_calls to Gemini functionCall parts', t => {
  const plugin = createPlugin();

  const messages = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Find the cannes file' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'WorkspaceSSH_123',
        type: 'function',
        function: {
          name: 'WorkspaceSSH',
          arguments: JSON.stringify({ command: 'ls -R | grep -i cannes' })
        }
      }]
    },
    {
      role: 'tool',
      tool_call_id: 'WorkspaceSSH_123',
      content: 'cannes_report.pdf'
    },
    { role: 'user', content: 'Open that file' },
  ];

  const { modifiedMessages, system } = plugin.convertMessagesToGemini(messages);

  // System message should be extracted
  t.truthy(system);
  t.is(system.parts[0].text, 'You are a helpful assistant.');

  // Find the model message with functionCall
  const fcMessage = modifiedMessages.find(m =>
    m.role === 'model' && m.parts.some(p => p.functionCall)
  );
  t.truthy(fcMessage, 'Should have a model message with functionCall');
  t.is(fcMessage.parts[0].functionCall.name, 'WorkspaceSSH');
  t.deepEqual(fcMessage.parts[0].functionCall.args, { command: 'ls -R | grep -i cannes' });

  // Find the function response message
  const frMessage = modifiedMessages.find(m =>
    m.role === 'function' && m.parts.some(p => p.functionResponse)
  );
  t.truthy(frMessage, 'Should have a function response message');
  t.is(frMessage.parts[0].functionResponse.name, 'WorkspaceSSH');
  t.is(frMessage.parts[0].functionResponse.response.content, 'cannes_report.pdf');
});

test('convertMessagesToGemini handles tool_calls with text content', t => {
  const plugin = createPlugin();

  const messages = [
    { role: 'user', content: 'Search for files' },
    {
      role: 'assistant',
      content: 'Let me search for that.',
      tool_calls: [{
        id: 'Search_1',
        type: 'function',
        function: {
          name: 'Search',
          arguments: '{"query": "cannes"}'
        }
      }]
    },
    {
      role: 'tool',
      tool_call_id: 'Search_1',
      content: 'Found 3 results'
    },
  ];

  const { modifiedMessages } = plugin.convertMessagesToGemini(messages);

  // The model message should have both text and functionCall parts
  const fcMessage = modifiedMessages.find(m =>
    m.role === 'model' && m.parts.some(p => p.functionCall)
  );
  t.truthy(fcMessage);
  t.is(fcMessage.parts.length, 2, 'Should have text + functionCall parts');
  t.is(fcMessage.parts[0].text, 'Let me search for that.');
  t.is(fcMessage.parts[1].functionCall.name, 'Search');
});

test('convertMessagesToGemini preserves thoughtSignature on tool_calls', t => {
  const plugin = createPlugin();

  const messages = [
    { role: 'user', content: 'Do something' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'Tool_1',
        type: 'function',
        function: { name: 'MyTool', arguments: '{}' },
        thoughtSignature: 'abc123sig'
      }]
    },
    { role: 'tool', tool_call_id: 'Tool_1', content: 'done' },
  ];

  const { modifiedMessages } = plugin.convertMessagesToGemini(messages);

  const fcMessage = modifiedMessages.find(m =>
    m.role === 'model' && m.parts.some(p => p.functionCall)
  );
  t.truthy(fcMessage);
  t.is(fcMessage.parts[0].thoughtSignature, 'abc123sig');
});

test('convertMessagesToGemini parses native Gemini function_call args strings', t => {
  const plugin = createPlugin();

  const messages = [{
    role: 'model',
    parts: [{
      function_call: {
        name: 'SearchAvailableTools',
        args: '{"query":"recently created issues"}',
      },
    }],
  }];

  const { modifiedMessages } = plugin.convertMessagesToGemini(messages);

  t.deepEqual(modifiedMessages[0].parts[0].function_call.args, {
    query: 'recently created issues',
  });
});

test('parseResponse gracefully handles non-streaming UNEXPECTED_TOOL_CALL', t => {
  const plugin = createPlugin();

  const result = plugin.parseResponse({
    candidates: [{
      finishReason: 'UNEXPECTED_TOOL_CALL',
      finishMessage: 'Model tried to call an undeclared function',
      content: { parts: [] },
    }],
  });

  t.is(result.finishReason, 'stop');
  t.true(result.output_text.includes('try rephrasing'));
});

test('parseResponse maps non-streaming prompt feedback block to content_filter', t => {
  const plugin = createPlugin();

  const result = plugin.parseResponse({
    promptFeedback: { blockReason: 'SAFETY' },
  });

  t.is(result.finishReason, 'content_filter');
  t.true(result.output_text.includes('SAFETY'));
});

test('getRequestParameters sends Gemini safety settings with REST field casing', t => {
  const plugin = createPlugin();
  const safetySettings = [
    {
      category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
      threshold: 'BLOCK_NONE',
    },
  ];

  const params = plugin.getRequestParameters(
    'hello',
    {},
    { prompt: '{{text}}' },
    { pathway: { geminiSafetySettings: safetySettings } },
  );

  t.deepEqual(params.safetySettings, safetySettings);
  t.falsy(params.safety_settings);
});

test('convertMessagesToGemini drops assistant with empty content and no tool_calls', t => {
  const plugin = createPlugin();

  // This is the old bug scenario: assistant with content="" and no tool_calls
  // should be dropped (existing behavior, regression check)
  const messages = [
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'World' },
  ];

  const { modifiedMessages } = plugin.convertMessagesToGemini(messages);

  // Should only have user messages (empty assistant dropped)
  t.true(modifiedMessages.every(m => m.role === 'user'));
});

test('processStreamEvent accumulates tool calls across events and dispatches once on STOP', t => {
  // Simulates Gemini 3.5 Flash pattern: 3 separate SSE events, each with a functionCall
  // + usageMetadata, only the last has finishReason: "STOP".
  // Verify: exactly ONE callback with ALL 3 tool calls.
  const toolCallbackArgs = [];
  const plugin = createPlugin();
  plugin.pathwayToolCallback = (...args) => toolCallbackArgs.push(args);
  plugin.requestId = 'test-req-123';

  const mockResolver = { args: { text: 'test' } };
  requestState['test-req-123'] = { pathwayResolver: mockResolver };

  const responseId = 'resp-abc-123';

  // Event 1: functionCall + usageMetadata, NO finishReason
  plugin.processStreamEvent({
    data: JSON.stringify({
      candidates: [{
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'SearchInternet', args: { query: 'topic A' } } }]
        }
      }],
      usageMetadata: { trafficType: 'ON_DEMAND' },
      responseId
    })
  }, {});

  t.is(toolCallbackArgs.length, 0, 'Should NOT dispatch after event 1');
  t.is(plugin.toolCallsBuffer.length, 1, 'Should buffer 1 tool call');

  // Event 2: another functionCall + usageMetadata, NO finishReason
  plugin.processStreamEvent({
    data: JSON.stringify({
      candidates: [{
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'SearchInternet', args: { query: 'topic B' } } }]
        }
      }],
      usageMetadata: { trafficType: 'ON_DEMAND' },
      responseId
    })
  }, {});

  t.is(toolCallbackArgs.length, 0, 'Should NOT dispatch after event 2');
  t.is(plugin.toolCallsBuffer.length, 2, 'Should buffer 2 tool calls');

  // Event 3: functionCall + usageMetadata + finishReason: "STOP"
  const result = plugin.processStreamEvent({
    data: JSON.stringify({
      candidates: [{
        content: {
          role: 'model',
          parts: [{ functionCall: { name: 'SearchInternet', args: { query: 'topic C' } } }]
        },
        finishReason: 'STOP'
      }],
      usageMetadata: { trafficType: 'ON_DEMAND' },
      responseId
    })
  }, {});

  // Exactly ONE callback with ALL 3 tool calls
  t.true(result.toolCallbackInvoked, 'Should set toolCallbackInvoked on STOP');
  t.is(toolCallbackArgs.length, 1, 'Should invoke callback exactly once');

  const toolMessage = toolCallbackArgs[0][1];
  t.is(toolMessage.role, 'assistant');
  t.is(toolMessage.tool_calls.length, 3, 'Should include all 3 accumulated tool calls');
  t.is(toolMessage.tool_calls[0].function.name, 'SearchInternet');
  t.is(toolMessage.tool_calls[1].function.name, 'SearchInternet');
  t.is(toolMessage.tool_calls[2].function.name, 'SearchInternet');

  t.is(plugin.toolCallsBuffer.length, 0, 'Tool buffer should be cleared');

  delete requestState['test-req-123'];
});

test('processStreamEvent does NOT dispatch tool calls without finishReason STOP', t => {
  const toolCallbackArgs = [];
  const plugin = createPlugin();
  plugin.pathwayToolCallback = (...args) => toolCallbackArgs.push(args);
  plugin.requestId = 'test-req-456';

  requestState['test-req-456'] = { pathwayResolver: { args: {} } };

  // Intermediate event: functionCall + usageMetadata but no finishReason
  const event = {
    data: JSON.stringify({
      candidates: [{
        content: {
          role: 'model',
          parts: [{
            functionCall: {
              name: 'WorkspaceSSH',
              args: { command: 'ls' }
            }
          }]
        }
      }],
      usageMetadata: { trafficType: 'ON_DEMAND' },
      modelVersion: 'gemini-3.5-flash',
      responseId: 'test-response-id'
    })
  };

  const result = plugin.processStreamEvent(event, {});

  // Should NOT dispatch — waiting for STOP event
  t.falsy(result.toolCallbackInvoked, 'Should not dispatch without finishReason STOP');
  t.is(toolCallbackArgs.length, 0, 'Should not invoke callback');
  t.is(plugin.toolCallsBuffer.length, 1, 'Tool call should remain buffered');

  delete requestState['test-req-456'];
});

test('processStreamEvent resets state only on new responseId', t => {
  const plugin = createPlugin();
  plugin.pathwayToolCallback = () => {};
  plugin.requestId = 'test-req-reset';

  requestState['test-req-reset'] = { pathwayResolver: { args: {} } };

  // Event with responseId "A" — buffer a tool call
  plugin.processStreamEvent({
    data: JSON.stringify({
      candidates: [{
        content: { role: 'model', parts: [{ functionCall: { name: 'ToolA', args: {} } }] }
      }],
      responseId: 'response-A'
    })
  }, {});

  t.is(plugin.toolCallsBuffer.length, 1);

  // Another event with SAME responseId "A" — should accumulate, not reset
  plugin.processStreamEvent({
    data: JSON.stringify({
      candidates: [{
        content: { role: 'model', parts: [{ functionCall: { name: 'ToolB', args: {} } }] }
      }],
      responseId: 'response-A'
    })
  }, {});

  t.is(plugin.toolCallsBuffer.length, 2, 'Should accumulate within same responseId');

  // Event with NEW responseId "B" — should reset
  plugin.processStreamEvent({
    data: JSON.stringify({
      candidates: [{
        content: { role: 'model', parts: [{ functionCall: { name: 'ToolC', args: {} } }] }
      }],
      responseId: 'response-B'
    })
  }, {});

  t.is(plugin.toolCallsBuffer.length, 1, 'Should reset on new responseId');
  t.is(plugin.toolCallsBuffer[0].function.name, 'ToolC');

  delete requestState['test-req-reset'];
});

test('processStreamEvent handles UNEXPECTED_TOOL_CALL by closing stream gracefully', t => {
  const toolCallbackArgs = [];
  const plugin = createPlugin();
  plugin.pathwayToolCallback = (...args) => toolCallbackArgs.push(args);
  plugin.requestId = 'test-req-789';

  requestState['test-req-789'] = { pathwayResolver: { args: {} } };

  // Gemini returns UNEXPECTED_TOOL_CALL when model calls an undeclared function
  const event = {
    data: JSON.stringify({
      candidates: [{
        content: {
          role: 'model',
          parts: [{
            functionCall: {
              name: 'SearchFileCollection',
              args: { query: 'test.png' }
            }
          }]
        },
        finishReason: 'UNEXPECTED_TOOL_CALL',
        finishMessage: 'Unexpected tool call: Model tried to call an undeclared function: SearchFileCollection'
      }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 },
      responseId: 'test-response-id'
    })
  };

  const result = plugin.processStreamEvent(event, {});

  // Should close the stream gracefully, NOT dispatch the invalid tool call
  t.is(result.progress, 1, 'Should close the stream');
  t.falsy(result.toolCallbackInvoked, 'Should not invoke tool callback for undeclared function');
  t.is(toolCallbackArgs.length, 0, 'Should not dispatch invalid tool call');
  t.is(plugin.toolCallsBuffer.length, 0, 'Should clear tool buffer');

  delete requestState['test-req-789'];
});
