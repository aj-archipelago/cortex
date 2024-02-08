// openai_api.test.js

import test from 'ava';
import got from 'got';
import axios from 'axios';
import serverFactory from '../index.js';

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

test('GET /models', async (t) => {
  const response = await got(`${API_BASE}/models`, { responseType: 'json' });
  t.is(response.statusCode, 200);
  t.is(response.body.object, 'list');
  t.true(Array.isArray(response.body.data));
});

test('POST /completions', async (t) => {
  const response = await got.post(`${API_BASE}/completions`, {
    json: {
      model: 'gpt-3.5-turbo',
      prompt: 'Word to your motha!',
      stream: false,
    },
    responseType: 'json',
  });

  t.is(response.statusCode, 200);
  t.is(response.body.object, 'text_completion');
  t.true(Array.isArray(response.body.choices));
});


test('POST /chat/completions', async (t) => {
  const response = await got.post(`${API_BASE}/chat/completions`, {
    json: {
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: 'Hello!' }],
      stream: false,
    },
    responseType: 'json',
  });

  t.is(response.statusCode, 200);
  t.is(response.body.object, 'chat.completion');
  t.true(Array.isArray(response.body.choices));
});

async function connectToSSEEndpoint(url, endpoint, payload, t, customAssertions) {
    return new Promise(async (resolve, reject) => {
        try {
            const instance = axios.create({
                baseURL: url,
                responseType: 'stream',
            });
        
            const response = await instance.post(endpoint, payload);
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
        
        } catch (error) {
            console.error('Error connecting to SSE endpoint:', error);
            reject(error);
        }
    });
}

test('POST SSE: /v1/completions should send a series of events and a [DONE] event', async (t) => {
    const payload = {
        model: 'gpt-3.5-turbo',
        prompt: 'Word to your motha!',
        stream: true,
    };
    
    const url = `http://localhost:${process.env.CORTEX_PORT}/v1`;
    
    const completionsAssertions = (t, messageJson) => {
        t.truthy(messageJson.id);
        t.is(messageJson.object, 'text_completion');
        t.truthy(messageJson.choices[0].finish_reason === null || messageJson.choices[0].finish_reason === 'stop');
    };
    
    await connectToSSEEndpoint(url, '/completions', payload, t, completionsAssertions);
});

test('POST SSE: /v1/chat/completions should send a series of events and a [DONE] event', async (t) => {
    const payload = {
        model: 'gpt-3.5-turbo',
        messages: [
        {
            role: 'user',
            content: 'Hello!',
        },
        ],
        stream: true,
    };
    
    const url = `http://localhost:${process.env.CORTEX_PORT}/v1`;
    
    const chatCompletionsAssertions = (t, messageJson) => {
        t.truthy(messageJson.id);
        t.is(messageJson.object, 'chat.completion.chunk');
        t.truthy(messageJson.choices[0].delta);
        t.truthy(messageJson.choices[0].finish_reason === null || messageJson.choices[0].finish_reason === 'stop');
    };
    
    await connectToSSEEndpoint(url, '/chat/completions', payload, t, chatCompletionsAssertions);
});  
  
