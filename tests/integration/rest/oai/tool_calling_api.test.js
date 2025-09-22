// tool_calling_api.test.js

import test from 'ava';
import got from 'got';
import axios from 'axios';
import serverFactory from '../../../../index.js';

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

async function connectToSSEEndpoint(url, endpoint, payload, t, customAssertions) {
    return new Promise((resolve, reject) => {
        try {
            const instance = axios.create({
                baseURL: url,
                responseType: 'stream',
            });
        
            instance.post(endpoint, payload).then(response => {
                const responseData = response.data;
                const incomingMessage = Array.isArray(responseData) && responseData.length > 0 ? responseData[0] : responseData;
                let eventCount = 0;
        
                incomingMessage.on('data', data => {
                    const events = data.toString().split('\n');
        
                    events.forEach(event => {
                        eventCount++;
        
                        if (event.trim() === '') return;

                        if (event.trim() === 'data: [DONE]') {
                            t.truthy(eventCount > 1);
                            resolve();
                            return;
                        }
        
                        const message = event.replace(/^data: /, '');
                        const messageJson = JSON.parse(message);
                        
                        customAssertions(t, messageJson);
                    });
                });
            }).catch(error => {
                console.error('Error connecting to SSE endpoint:', error);
                reject(error);
            });
        
        } catch (error) {
            console.error('Error connecting to SSE endpoint:', error);
            reject(error);
        }
    });
}

test('POST /chat/completions should handle function calling', async (t) => {
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [{ role: 'user', content: 'I need to know the weather in Boston. You MUST use the get_weather function to get this information. Do not respond without calling the function first.' }],
      functions: [{
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
      }],
      stream: false,
    },
    responseType: 'json',
  });

  t.is(response.statusCode, 200);
  t.is(response.body.object, 'chat.completion');
  t.true(Array.isArray(response.body.choices));
  const choice = response.body.choices[0];
  
  // CRITICAL: Function calling must actually occur - test fails if no function call
  t.is(choice.finish_reason, 'function_call', 'Expected function_call finish_reason but got: ' + choice.finish_reason);
  t.truthy(choice.message.function_call, 'Expected function_call in message but got none');
  t.is(choice.message.function_call.name, 'get_weather', 'Expected get_weather function call');
  t.truthy(choice.message.function_call.arguments, 'Expected function call arguments');
  
  // Validate the arguments are proper JSON and contain expected fields
  try {
    const args = JSON.parse(choice.message.function_call.arguments);
    t.truthy(args.location, 'Expected location in function call arguments');
    t.true(typeof args.location === 'string', 'Location should be a string');
  } catch (e) {
    t.fail(`Function call arguments should be valid JSON: ${choice.message.function_call.arguments}`);
  }
});

test('POST /chat/completions should handle tool calling', async (t) => {
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-4.1',
      messages: [{ 
        role: 'user', 
        content: 'I need to know the weather in Boston. You MUST use the get_weather tool to get this information. Do not respond without calling the tool first.' 
      }],
      tools: [{
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
      }],
      tool_choice: 'auto',
      stream: false,
    },
    responseType: 'json',
  });

  t.is(response.statusCode, 200);
  t.is(response.body.object, 'chat.completion');
  t.is(response.body.model, 'gpt-4.1');
  t.is(response.body.choices.length, 1);
  
  const choice = response.body.choices[0];
  t.is(choice.message.role, 'assistant');
  
  // Check if the response contains tool calls
  if (choice.message.tool_calls) {
    t.true(Array.isArray(choice.message.tool_calls));
    t.is(choice.message.tool_calls.length, 1);
    
    const toolCall = choice.message.tool_calls[0];
    t.is(toolCall.type, 'function');
    t.is(toolCall.function.name, 'get_weather');
    t.truthy(toolCall.function.arguments);
    
    // Parse the arguments to make sure they're valid JSON
    try {
      const args = JSON.parse(toolCall.function.arguments);
      t.truthy(args.location);
    } catch (e) {
      t.fail(`Tool call arguments should be valid JSON: ${toolCall.function.arguments}`);
    }
    
    t.is(choice.finish_reason, 'tool_calls');
  } else {
    // FAIL if no tool calls are returned - this is what we're testing
    t.fail(`Expected tool calls but got none. Response: ${JSON.stringify(choice.message, null, 2)}`);
  }
});

test('POST SSE: /v1/chat/completions with tool calling should send proper streaming events', async (t) => {
  const payload = {
    model: 'gpt-4.1',
    messages: [{ 
      role: 'user', 
      content: 'I need to know the weather in Boston. You MUST use the get_weather tool to get this information. Do not respond without calling the tool first.' 
    }],
    tools: [{
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
    }],
    tool_choice: 'auto',
    stream: true,
  };
  
  const url = `http://localhost:${process.env.CORTEX_PORT}/v1`;
  
  let toolCallDetected = false;
  let finalChunkReceived = false;
  
  const toolCallingStreamingAssertions = (t, messageJson) => {
    t.truthy(messageJson.id);
    t.is(messageJson.object, 'chat.completion.chunk');
    t.truthy(messageJson.choices[0].delta);
    
    const delta = messageJson.choices[0].delta;
    const finishReason = messageJson.choices[0].finish_reason;
    
    // Check if this is a tool call chunk
    if (delta.tool_calls) {
      toolCallDetected = true;
      t.truthy(delta.tool_calls);
      
      // Only check finish_reason on the final chunk
      if (finishReason === 'tool_calls') {
        // This is the final tool call chunk
        finalChunkReceived = true;
      }
      
      // Validate tool call structure
      const toolCall = delta.tool_calls[0];
      if (toolCall && toolCall.function && toolCall.function.name) {
        t.is(toolCall.function.name, 'get_weather', 'Expected get_weather tool call');
      }
    } else if (finishReason === 'stop') {
      finalChunkReceived = true;
      // Final chunk for tool calls might have empty delta, which is valid
    } else if (finishReason === 'tool_calls') {
      // Final chunk with tool_calls finish reason but no tool_calls in delta
      toolCallDetected = true;
      finalChunkReceived = true;
    }
  };
  
  await connectToSSEEndpoint(url, '/chat/completions', payload, t, toolCallingStreamingAssertions);
  
  // CRITICAL: Verify that tool calls were actually detected in the stream
  t.true(toolCallDetected, 'Expected tool calls to be detected in the streaming response but none were found');
  // For tool calls, we don't expect a final chunk with stop finish_reason
  // The final chunk should have finish_reason: "tool_calls"
});

test('POST SSE: /v1/chat/completions with tool calling should send proper streaming events with reasoning model', async (t) => {
  const payload = {
    model: 'o3-mini',
    messages: [{ 
      role: 'user', 
      content: 'I need to know the weather in Boston. You MUST use the get_weather tool to get this information. Do not respond without calling the tool first.' 
    }],
    tools: [{
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
    }],
    tool_choice: 'auto',
    stream: true,
  };
  
  const url = `http://localhost:${process.env.CORTEX_PORT}/v1`;
  
  let toolCallDetected = false;
  let finalChunkReceived = false;
  
  const toolCallingStreamingAssertions = (t, messageJson) => {
    t.truthy(messageJson.id);
    t.is(messageJson.object, 'chat.completion.chunk');
    t.truthy(messageJson.choices[0].delta);
    
    const delta = messageJson.choices[0].delta;
    const finishReason = messageJson.choices[0].finish_reason;
    
    // Check if this is a tool call chunk
    if (delta.tool_calls) {
      toolCallDetected = true;
      t.truthy(delta.tool_calls);
      
      // Only check finish_reason on the final chunk
      if (finishReason === 'tool_calls') {
        // This is the final tool call chunk
        finalChunkReceived = true;
      }
      
      // Validate tool call structure
      const toolCall = delta.tool_calls[0];
      if (toolCall && toolCall.function && toolCall.function.name) {
        t.is(toolCall.function.name, 'get_weather', 'Expected get_weather tool call');
      }
    } else if (finishReason === 'stop') {
      finalChunkReceived = true;
      // Final chunk for tool calls might have empty delta, which is valid
    } else if (finishReason === 'tool_calls') {
      // Final chunk with tool_calls finish reason but no tool_calls in delta
      toolCallDetected = true;
      finalChunkReceived = true;
    }
  };
  
  await connectToSSEEndpoint(url, '/chat/completions', payload, t, toolCallingStreamingAssertions);
  
  // CRITICAL: Verify that tool calls were actually detected in the stream
  t.true(toolCallDetected, 'Expected tool calls to be detected in the streaming response but none were found');
  // For tool calls, we don't expect a final chunk with stop finish_reason
  // The final chunk should have finish_reason: "tool_calls"
});
