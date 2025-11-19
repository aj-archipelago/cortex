// message_content_compliance.test.js
// Comprehensive test for message content compliance through REST and plugin transformations
// Tests all valid OpenAI API message content variations according to the spec

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

// Helper to check if content is compliant (string, null, or array of objects with type field)
function isContentCompliant(content) {
  if (content === null || typeof content === 'string') {
    return true;
  }
  if (Array.isArray(content)) {
    return content.every(item => 
      typeof item === 'object' && 
      item !== null && 
      typeof item.type === 'string'
    );
  }
  return false;
}

// Helper to check if content array contains only text objects
function isTextContentArray(content) {
  if (!Array.isArray(content)) return false;
  return content.every(item => 
    typeof item === 'object' && 
    item !== null && 
    item.type === 'text' && 
    typeof item.text === 'string'
  );
}

test('POST /chat/completions - user message with string content', async (t) => {
  // Spec: User message content can be a string
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: 'Hello, how are you?'
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - user message with array of text content parts', async (t) => {
  // Spec: User message content can be an array of content parts (objects with type field)
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'First part' },
            { type: 'text', text: 'Second part' }
          ]
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - user message with array containing strings (should be converted)', async (t) => {
  // This tests that strings in arrays get converted to text content objects
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: ['String 1', 'String 2'] // Should be converted to [{type: 'text', text: 'String 1'}, ...]
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - system message with string content', async (t) => {
  // Spec: System message content can be a string
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant.'
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - system message with array of text content parts', async (t) => {
  // Spec: System message content can be an array of text content parts
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'You are a helpful assistant.' }
          ]
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - system message with array containing strings (should be converted)', async (t) => {
  // This tests that strings in arrays get converted to text content objects
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'system',
          content: ['System instruction 1', 'System instruction 2'] // Should be converted
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - assistant message with string content', async (t) => {
  // Spec: Assistant message content can be a string
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: 'Hello'
        },
        {
          role: 'assistant',
          content: 'Hi there!'
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - assistant message with array of text content parts', async (t) => {
  // Spec: Assistant message content can be an array of content parts
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: 'Hello'
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Response part 1' },
            { type: 'text', text: 'Response part 2' }
          ]
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - assistant message with null content and tool_calls', async (t) => {
  // Spec: Assistant message content can be null if tool_calls is specified
  // This tests that null is preserved through transformations and sent to the API
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: 'What is the weather?'
        },
        {
          role: 'assistant',
          content: null, // Should be preserved as null (not converted to empty string)
          tool_calls: [{
            id: 'call_123',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"location": "San Francisco"}'
            }
          }]
        },
        {
          role: 'tool',
          content: 'Sunny, 72°F',
          tool_call_id: 'call_123'
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
  // The request should succeed, meaning null content was preserved and accepted by OpenAI API
});

test('POST /chat/completions - assistant message with empty string content and tool_calls', async (t) => {
  // Spec: Assistant message content can be empty string with tool_calls
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: 'What is the weather?'
        },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_123',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"location": "San Francisco"}'
            }
          }]
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - assistant message with array containing strings and tool_calls (should be converted)', async (t) => {
  // This tests the bug fix: arrays with strings must be converted to text content objects
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: 'What is the weather?'
        },
        {
          role: 'assistant',
          content: ['Response text'], // Should be converted to [{type: 'text', text: 'Response text'}]
          tool_calls: [{
            id: 'call_123',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"location": "San Francisco"}'
            }
          }]
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - tool message with string content', async (t) => {
  // Spec: Tool message content can be a string
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
              name: 'get_weather',
              arguments: '{}'
            }
          }]
        },
        {
          role: 'tool',
          content: 'The weather is sunny.',
          tool_call_id: 'call_123'
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - tool message with array of text content parts', async (t) => {
  // Spec: Tool message content can be an array of text content parts
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
              name: 'get_weather',
              arguments: '{}'
            }
          }]
        },
        {
          role: 'tool',
          content: [
            { type: 'text', text: 'Result part 1' },
            { type: 'text', text: 'Result part 2' }
          ],
          tool_call_id: 'call_123'
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - tool message with array containing strings (should be converted)', async (t) => {
  // This tests that strings in tool message arrays get converted to text content objects
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
              name: 'get_weather',
              arguments: '{}'
            }
          }]
        },
        {
          role: 'tool',
          content: ['Result 1', 'Result 2'], // Should be converted to [{type: 'text', text: 'Result 1'}, ...]
          tool_call_id: 'call_123'
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - tool message with empty string content', async (t) => {
  // Spec: Tool message content can be empty string
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
              name: 'get_weather',
              arguments: '{}'
            }
          }]
        },
        {
          role: 'tool',
          content: '',
          tool_call_id: 'call_123'
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - tool message with null content (should be converted to empty string)', async (t) => {
  // Spec: Tool message content should not be null, but we should handle it gracefully
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
              name: 'get_weather',
              arguments: '{}'
            }
          }]
        },
        {
          role: 'tool',
          content: null, // Should be converted to empty string
          tool_call_id: 'call_123'
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - complex conversation with all content variations', async (t) => {
  // Test a full conversation with all valid content variations
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant.' // String
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hello' }] // Array of objects
        },
        {
          role: 'assistant',
          content: 'Hi there!' // String
        },
        {
          role: 'user',
          content: 'What can you do?' // String
        },
        {
          role: 'assistant',
          content: null, // Null with tool_calls
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: {
              name: 'get_info',
              arguments: '{}'
            }
          }]
        },
        {
          role: 'tool',
          content: 'Tool result', // String
          tool_call_id: 'call_1'
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Based on the tool result...' }] // Array of objects
        },
        {
          role: 'user',
          content: ['Question part 1', 'Question part 2'] // Array with strings - should be converted
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - user message with image content part', async (t) => {
  // Spec: User messages can have image content parts
  // Note: This test may timeout if image URL validation fails, but it tests the content structure
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { 
              type: 'image_url',
              image_url: {
                url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
              }
            }
          ]
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false,
    timeout: {
      request: 5000
    }
  });

  // Image validation may fail, but we're testing the content structure compliance
  // Status code could be 200 (success) or 400 (invalid image), but structure should be valid
  t.true([200, 400].includes(response.statusCode));
});

test('POST /chat/completions - mixed content array with strings and objects (should convert strings)', async (t) => {
  // Test that mixed arrays (strings + objects) get properly converted
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: [
            'Plain string', // Should be converted to {type: 'text', text: 'Plain string'}
            { type: 'text', text: 'Already an object' } // Should stay as is
          ]
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - assistant message with empty array content and tool_calls', async (t) => {
  // Edge case: empty array with tool_calls
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          content: 'Test'
        },
        {
          role: 'assistant',
          content: [], // Empty array
          tool_calls: [{
            id: 'call_123',
            type: 'function',
            function: {
              name: 'test_function',
              arguments: '{}'
            }
          }]
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

test('POST /chat/completions - messages with name fields and various content types', async (t) => {
  // Test name fields with different content types
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [
        {
          role: 'user',
          name: 'user1',
          content: 'Message from user1' // String
        },
        {
          role: 'assistant',
          name: 'assistant1',
          content: [{ type: 'text', text: 'Response from assistant1' }] // Array
        },
        {
          role: 'user',
          name: 'user2',
          content: ['Message', 'from', 'user2'] // Array with strings - should be converted
        }
      ],
      stream: false
    },
    responseType: 'json',
    throwHttpErrors: false
  });

  t.is(response.statusCode, 200);
  t.truthy(response.body);
});

