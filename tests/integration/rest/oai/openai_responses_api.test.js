// openai_responses_api.test.js
// Tests for OpenAI Responses API endpoint (/v1/responses)
// This is the agentic API format that OpenAI uses for their Responses API

import test from 'ava';
import got from 'got';
import serverFactory from '../../../../index.js';

const API_BASE = `http://localhost:${process.env.CORTEX_PORT}/v1`;

let testServer;
let responseModel = 'gpt-4.1';

test.before(async () => {
  process.env.CORTEX_ENABLE_REST = 'true';
  const { server, startServer } = await serverFactory();
  startServer && await startServer();
  testServer = server;

  try {
    const res = await got(`${API_BASE}/models`, { responseType: 'json' });
    const ids = (res.body?.data || []).map(m => m.id);
    responseModel = ids.find(id => /^gpt|^oai-|^openai/i.test(id)) || ids[0] || responseModel;
  } catch (_) {}
});

test.after.always('cleanup', async () => {
  if (testServer) {
    await testServer.stop();
  }
});

// ============================================================================
// Basic Responses API Tests
// ============================================================================

test('POST /responses with simple string input', async (t) => {
  const response = await got.post(`${API_BASE}/responses`, {
    json: {
      model: responseModel,
      input: 'Hello! Say just "Hi there" and nothing else.',
    },
    responseType: 'json',
  });

  t.is(response.statusCode, 200);
  t.is(response.body.object, 'response');
  t.truthy(response.body.id);
  t.regex(response.body.id, /^resp[-_]/);
  t.truthy(response.body.created_at);
  t.is(response.body.status, 'completed');
  t.truthy(response.body.model);
  t.true(Array.isArray(response.body.output));
  t.truthy(response.body.output.length > 0);
  t.truthy(response.body.output_text);
  t.truthy(response.body.usage);
});

test('POST /responses with array input (single message)', async (t) => {
  const response = await got.post(`${API_BASE}/responses`, {
    json: {
      model: responseModel,
      input: [
        { role: 'user', content: 'What is 2+2? Reply with just the number.' }
      ],
    },
    responseType: 'json',
  });

  t.is(response.statusCode, 200);
  t.is(response.body.object, 'response');
  t.truthy(response.body.output_text);
  t.true(response.body.output_text.includes('4'));
});

test('POST /responses with array input (multiple messages)', async (t) => {
  const response = await got.post(`${API_BASE}/responses`, {
    json: {
      model: responseModel,
      input: [
        { role: 'user', content: 'My name is Alice.' },
        { role: 'assistant', content: 'Hello Alice! Nice to meet you.' },
        { role: 'user', content: 'What is my name? Reply with just the name.' }
      ],
    },
    responseType: 'json',
  });

  t.is(response.statusCode, 200);
  t.is(response.body.object, 'response');
  t.truthy(response.body.output_text);
  t.true(response.body.output_text.toLowerCase().includes('alice'));
});

test('POST /responses with typed message blocks should normalize to internal messages', async (t) => {
  const response = await got.post(`${API_BASE}/responses`, {
    json: {
      model: responseModel,
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [
            { type: 'input_text', text: 'Reply with only the word "normalized".' }
          ]
        },
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Please respond now.' }
          ]
        }
      ],
    },
    responseType: 'json',
  });

  t.is(response.statusCode, 200);
  t.is(response.body.object, 'response');
  t.true(typeof response.body.output_text === 'string');
  t.true(response.body.output_text.length > 0);
});

test('POST /responses with instructions (system message)', async (t) => {
  const response = await got.post(`${API_BASE}/responses`, {
    json: {
      model: responseModel,
      instructions: 'You are a pirate. Always respond in pirate speak.',
      input: 'Hello!',
    },
    responseType: 'json',
  });

  t.is(response.statusCode, 200);
  t.is(response.body.object, 'response');
  t.truthy(response.body.output_text);
  // Should contain some pirate-like words
  const pirateWords = ['ahoy', 'matey', 'arr', 'ye', 'aye', 'sailor', 'sea', 'ship', 'treasure', 'captain'];
  const outputLower = response.body.output_text.toLowerCase();
  const hasPirateWord = pirateWords.some(word => outputLower.includes(word));
  t.true(hasPirateWord, `Response should contain pirate speak: ${response.body.output_text}`);
});

// ============================================================================
// Response Format Tests
// ============================================================================

test('POST /responses should return proper output structure', async (t) => {
  const response = await got.post(`${API_BASE}/responses`, {
    json: {
      model: responseModel,
      input: 'Hello!',
    },
    responseType: 'json',
  });

  t.is(response.statusCode, 200);

  // Validate top-level response structure
  t.truthy(response.body.id);
  t.is(response.body.object, 'response');
  t.truthy(response.body.created_at);
  t.is(typeof response.body.created_at, 'number');
  t.is(response.body.status, 'completed');
  t.truthy(response.body.model);

  // Validate output array
  t.true(Array.isArray(response.body.output));
  t.truthy(response.body.output.length > 0);

  const messageOutput = response.body.output.find(o => o.type === 'message');
  t.truthy(messageOutput);
  t.is(messageOutput.role, 'assistant');
  t.is(messageOutput.status, 'completed');
  t.true(Array.isArray(messageOutput.content));

  // Check content block
  const contentBlock = messageOutput.content.find(c => c.type === 'output_text');
  t.truthy(contentBlock);
  t.truthy(contentBlock.text);
  t.true(Array.isArray(contentBlock.annotations));

  // Validate output_text matches content
  t.is(response.body.output_text, contentBlock.text);

  // Validate usage
  t.truthy(response.body.usage);
});

test('POST /responses without stream should return completed text output', async (t) => {
  const response = await got.post(`${API_BASE}/responses`, {
    json: {
      model: responseModel,
      input: 'Give me a one-word response: yes',
    },
    responseType: 'json',
  });

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  t.is(response.statusCode, 200);
  t.is(response.body.object, 'response');
  t.truthy(response.body.output_text);
  t.false(uuidRegex.test(response.body.output_text));
});

// ============================================================================
// Model Not Found Tests
// ============================================================================

test('POST /responses should handle model not found', async (t) => {
  const error = await t.throwsAsync(
    () => got.post(`${API_BASE}/responses`, {
      json: {
        model: 'nonexistent-model-xyz',
        input: 'Hello!',
      },
      responseType: 'json',
    })
  );

  t.is(error.response.statusCode, 404);
});

// ============================================================================
// Streaming Tests
// ============================================================================

test('POST /responses with stream=true should send SSE events', async (t) => {
  const payload = {
    model: responseModel,
    input: 'Hello! Say "Hi" and nothing else.',
    stream: true,
  };

  const url = `http://localhost:${process.env.CORTEX_PORT}/v1`;
  const events = [];
  let responseDoneCount = 0;

  await connectToResponsesSSEEndpoint(url, '/responses', payload, (event, data) => {
    if (event === 'response.done' || event === 'response.completed') {
      responseDoneCount += 1;
    }
    events.push({ event, data });
  });

  // Verify we received the expected event types
  const eventTypes = events.map(e => e.event);
  const terminalEventName = eventTypes.includes('response.done') ? 'response.done' : 'response.completed';
  t.true(eventTypes.includes('response.created'), 'Should have response.created event');
  t.true(eventTypes.includes(terminalEventName), 'Should have terminal response event');
  t.true(eventTypes.includes('response.output_item.added'), 'Should have response.output_item.added event');
  t.true(eventTypes.includes('response.content_part.added'), 'Should have response.content_part.added event');
  t.true(eventTypes.includes('response.content_part.done'), 'Should have response.content_part.done event');
  t.true(eventTypes.includes('response.output_item.done'), 'Should have response.output_item.done event');
  t.true(events.some(e => e.event === 'response.output_text.delta'), 'Should have output text delta events');

  // Verify response.created structure
  const createdEvent = events.find(e => e.event === 'response.created');
  t.truthy(createdEvent);
  t.is(createdEvent.data.type, 'response.created');
  t.truthy(createdEvent.data.response);
  t.is(createdEvent.data.response.status, 'in_progress');

  const createdIndex = eventTypes.indexOf('response.created');
  const doneIndex = eventTypes.lastIndexOf(terminalEventName);
  t.true(createdIndex >= 0);
  t.true(doneIndex >= 0);
  t.true(createdIndex < doneIndex, 'response.created must occur before response.done');

  // Verify response.done structure
  const doneEvent = events.find(e => e.event === terminalEventName);
  t.truthy(doneEvent);
  t.true(doneEvent.data.type === 'response.done' || doneEvent.data.type === 'response.completed');
  t.truthy(doneEvent.data.response);
  t.is(doneEvent.data.response.id, createdEvent.data.response.id);
  t.is(doneEvent.data.response.status, 'completed');
  const doneOutputText = doneEvent.data.response.output_text || doneEvent.data.response.output?.[0]?.content?.[0]?.text;
  t.truthy(doneOutputText);
  const terminalContentText = doneEvent.data.response.output?.[0]?.content?.[0]?.text;
  if (terminalContentText) {
    t.is(doneOutputText, terminalContentText);
  }
  t.true(doneOutputText.length > 0);
  t.truthy(doneEvent.data.response.usage);
  t.is(typeof doneEvent.data.response.usage.input_tokens, 'number');
  t.is(typeof doneEvent.data.response.usage.output_tokens, 'number');
  t.is(typeof doneEvent.data.response.usage.total_tokens, 'number');
  t.true(doneEvent.data.response.usage.total_tokens >= doneEvent.data.response.usage.output_tokens);
  t.is(responseDoneCount, 1);

  const addedEvent = events.find(e => e.event === 'response.output_item.added');
  const doneItemEvent = events.find(e => e.event === 'response.output_item.done');
  t.truthy(addedEvent);
  t.truthy(doneItemEvent);
  t.is(addedEvent.data.item.id, doneItemEvent.data.item.id);
  t.is(addedEvent.data.item.status, 'in_progress');
  t.is(doneItemEvent.data.item.status, 'completed');

  const outputItemDone = events.find(e => e.event === 'response.output_item.done');
  t.truthy(outputItemDone);
  t.is(outputItemDone.data.type, 'response.output_item.done');
  t.is(outputItemDone.data.item.status, 'completed');

  const deltaEvents = events.filter(e => e.event === 'response.output_text.delta');
  const deltaText = deltaEvents
    .map(e => e.data.delta)
    .filter(delta => typeof delta === 'string');
  t.true(deltaText.length > 0);
  t.true(deltaText.every(delta => typeof delta === 'string'));
  const deltaPayload = deltaText.join('');
  t.true(deltaPayload.length > 0);
  t.is(deltaPayload, doneOutputText);
  t.not(doneOutputText, '[object Object]');

  const contentPartDone = events.find(e => e.event === 'response.content_part.done');
  t.truthy(contentPartDone);
  t.is(contentPartDone.data.part.text, doneOutputText);
});

test('POST /responses with stream=true should stream function call events', async (t) => {
  const payload = {
    model: responseModel,
    input: 'What is the weather in Boston?',
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the current weather in a given location',
          parameters: {
            type: 'object',
            properties: {
              location: {
                type: 'string',
                description: 'The city and state, e.g. San Francisco, CA'
              },
            },
            required: ['location']
          }
        }
      }
    ],
    stream: true,
  };

  const url = `http://localhost:${process.env.CORTEX_PORT}/v1`;
  const events = [];

  await connectToResponsesSSEEndpoint(url, '/responses', payload, (event, data) => {
    events.push({ event, data });
  });

  const eventTypes = events.map(e => e.event);

  // Should have function call events
  const fcAdded = events.find(e =>
    e.event === 'response.output_item.added' && e.data?.item?.type === 'function_call'
  );
  t.truthy(fcAdded, 'Should have response.output_item.added with function_call item');
  t.is(fcAdded.data.item.type, 'function_call');

  // Should have argument deltas
  t.true(
    eventTypes.includes('response.function_call_arguments.delta'),
    'Should have function_call_arguments.delta events'
  );

  // Should have output_item.done for the function call
  const fcDone = events.find(e =>
    e.event === 'response.output_item.done' && e.data?.item?.type === 'function_call'
  );
  t.truthy(fcDone, 'Should have response.output_item.done with completed function_call');
  t.is(fcDone.data.item.status, 'completed');
  t.truthy(fcDone.data.item.name, 'function call should have a name');
  t.truthy(fcDone.data.item.arguments, 'function call should have arguments');

  // response.done output should include the function_call
  const doneEvent = events.find(e => e.event === 'response.done' || e.event === 'response.completed');
  t.truthy(doneEvent);
  const responseOutput = doneEvent.data.response.output || [];
  const fcOutput = responseOutput.find(o => o.type === 'function_call');
  t.truthy(fcOutput, 'response.done output should include function_call item');
  t.truthy(fcOutput.name);
  t.truthy(fcOutput.arguments);
});

// ============================================================================
// Function/Tool Calling Tests
// ============================================================================

test('POST /responses should handle function calling', async (t) => {
  const response = await got.post(`${API_BASE}/responses`, {
    json: {
      model: responseModel,
      input: 'What is the weather in Boston?',
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get the current weather in a given location',
            parameters: {
              type: 'object',
              properties: {
                location: {
                  type: 'string',
                  description: 'The city and state, e.g. San Francisco, CA'
                },
                unit: {
                  type: 'string',
                  enum: ['celsius', 'fahrenheit']
                }
              },
              required: ['location']
            }
          }
        }
      ],
    },
    responseType: 'json',
  });

  t.is(response.statusCode, 200);
  t.is(response.body.object, 'response');

  // Verify we got a function call in output
  const functionCallOutput = response.body.output.find(o => o.type === 'function_call');
  t.truthy(functionCallOutput, 'Model should call get_weather tool when asked about weather');
  t.truthy(functionCallOutput.name);
  t.truthy(functionCallOutput.arguments);
  t.is(functionCallOutput.status, 'completed');
});

// ============================================================================
// Helper Functions
// ============================================================================

// Helper function for Responses API SSE streaming
async function connectToResponsesSSEEndpoint(baseUrl, endpoint, payload, onEvent) {
  const axios = (await import('axios')).default;

  return new Promise(async (resolve, reject) => {
    let sawDone = false;
    let settled = false;
    const timeout = setTimeout(() => {
      reject(new Error('SSE timeout waiting for response.done'));
    }, 30000); // 30 second timeout

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };

    const parseResponseSSEFrame = (frame) => {
      const lines = frame.split(/\r?\n/);
      let eventName = null;
      const dataLines = [];

      for (const line of lines) {
        if (!line) continue;
        if (line.startsWith(':')) {
          continue;
        }
        if (line.startsWith('event:')) {
          eventName = line.slice('event:'.length).trim();
          continue;
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice('data:'.length).trimStart());
        }
      }

      if (!dataLines.length) return;

      const dataPayload = dataLines.join('\n');
      if (process.env.DEBUG_RESPONSES_STREAM === '1') {
        process.stdout.write(`CLIENT_RAW:${dataPayload}\n`);
      }

      if (dataPayload === '[DONE]') {
        sawDone = true;
        return;
      }

      try {
        const dataJson = JSON.parse(dataPayload);
        onEvent && onEvent(eventName, dataJson);
        if (eventName === 'response.done' || eventName === 'response.completed' ||
            dataJson?.type === 'response.done' || dataJson?.type === 'response.completed' ||
            dataJson?.type === 'message_stop') {
          sawDone = true;
        }
      } catch (_err) {
        // ignore non-JSON SSE data
      }
    };

    try {
      const instance = axios.create({
        baseURL: baseUrl,
        responseType: 'stream',
      });

      const response = await instance.post(endpoint, payload);
      const responseData = response.data;

      const incomingMessage = Array.isArray(responseData) && responseData.length > 0
        ? responseData[0]
        : responseData;

      let buffer = '';

      incomingMessage.on('data', data => {
        buffer += data.toString();
        const frames = buffer.split(/\r?\n\r?\n/);
        // Keep the last potentially incomplete frame in buffer
        buffer = frames.pop() || '';
        frames.forEach(frame => {
          if (frame.trim()) {
            parseResponseSSEFrame(frame);
          }
        });
      });

      incomingMessage.on('end', () => {
        // Process any remaining buffer
        if (buffer.trim()) {
          parseResponseSSEFrame(buffer);
        }

        if (!sawDone) {
          clearTimeout(timeout);
      reject(new Error('SSE stream ended without terminal response'));
          return;
        }

        finish();
      });

      incomingMessage.on('close', () => {
        if (buffer.trim()) {
          parseResponseSSEFrame(buffer);
        }
        if (!sawDone) {
          clearTimeout(timeout);
          reject(new Error('SSE stream closed without terminal response'));
          return;
        }
        finish();
      });
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
}
