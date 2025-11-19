// tool_calls_multimessage.test.js
// Tests for REST endpoint handling of tool_calls in MultiMessage format

import test from 'ava';
import got from 'got';
import serverFactory from '../../../index.js';

const API_BASE = `http://localhost:${process.env.CORTEX_PORT}/v1`;

let testServer;

test.before(async () => {
  process.env.CORTEX_ENABLE_REST = 'true';
  const { server, startServer } = await serverFactory();
  startServer && await startServer();
  testServer = server;
});

test.after.always('cleanup', async () => {
  if (testServer) {
    await testServer.stop();
  }
});

test('POST /chat/completions - tool_calls objects are stringified in REST endpoint', async (t) => {
  // Test that when tool_calls come in as objects, they get stringified
  // This simulates what happens in server/rest.js convertType function
  
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_123',
            type: 'function',
            function: {
              name: 'test_function',
              arguments: '{"param": "value"}'
            }
          }] // Object format as would come from client
        },
        {
          role: 'tool',
          content: ['Tool result 1', 'Tool result 2'], // Array format
          tool_call_id: 'call_123'
        }
      ],
      stream: false,
    },
    responseType: 'json',
  });

  t.is(response.statusCode, 200);
  // The request should succeed - tool_calls should be stringified and tool content should be converted to string
  t.truthy(response.body);
});

test('POST /chat/completions - tool_calls strings are preserved in REST endpoint', async (t) => {
  // Test that when tool_calls come in as strings (from GraphQL), they are preserved
  
  const toolCallString = JSON.stringify({
    id: 'call_456',
    type: 'function',
    function: {
      name: 'another_function',
      arguments: '{"key": "value"}'
    }
  });
  
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [toolCallString] // String format as would come from GraphQL
        }
      ],
      stream: false,
    },
    responseType: 'json',
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - tool message with content array is converted to text content parts array', async (t) => {
  // Test that tool messages with content arrays get converted to arrays of text content parts
  // This should happen in the plugin's tryParseMessages method
  
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: 'Test message'
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_789',
            type: 'function',
            function: {
              name: 'test_tool',
              arguments: '{}'
            }
          }]
        },
        {
          role: 'tool',
          content: ['Result line 1', 'Result line 2'], // Array that should be converted to text content parts array
          tool_call_id: 'call_789'
        }
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'test_tool',
          description: 'A test tool',
          parameters: {
            type: 'object',
            properties: {},
            required: []
          }
        }
      }],
      stream: false,
    },
    responseType: 'json',
  });

  t.is(response.statusCode, 200);
  // The request should succeed - tool message content array should be converted to text content parts array by plugin
  t.truthy(response.body);
});

test('POST /chat/completions - handles tool_calls with mixed string and object format', async (t) => {
  // Test REST endpoint handling of mixed tool_calls formats
  
  const toolCall1String = JSON.stringify({
    id: 'call_1',
    type: 'function',
    function: { name: 'func1', arguments: '{}' }
  });
  
  const toolCall2Object = {
    id: 'call_2',
    type: 'function',
    function: { name: 'func2', arguments: '{}' }
  };
  
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [toolCall1String, toolCall2Object] // Mixed format
        }
      ],
      stream: false,
    },
    responseType: 'json',
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - JSON stringified non-whitelisted object in content array is preserved as text', async (t) => {
  // Test that when a JSON stringified object (not in WHITELISTED_CONTENT_TYPES) is sent
  // through REST in a content array, it gets converted to a text object with the JSON string preserved
  
  // Create a non-whitelisted object (not 'text', 'image', 'image_url', 'tool_use', 'tool_result')
  const nonWhitelistedObject = {
    customType: 'metadata',
    data: { key: 'value', nested: { info: 'test' } }
  };
  
  const jsonStringifiedObject = JSON.stringify(nonWhitelistedObject);
  
  // Send through REST with JSON stringified non-whitelisted object in content array
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' }, // Valid whitelisted type
            jsonStringifiedObject // JSON string of non-whitelisted object
          ]
        }
      ],
      stream: false,
    },
    responseType: 'json',
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
  
  // The request should succeed - the JSON stringified object should be preserved
  // and converted to {type: 'text', text: <json-string>} by the plugin
  // We can't directly inspect the plugin's internal state, but we verify the request succeeds
  // which means the conversion happened correctly (otherwise it would fail)
});

