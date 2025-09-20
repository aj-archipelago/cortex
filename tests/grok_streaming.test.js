// grok_streaming.test.js
// Basic text streaming test for Grok-4 via OpenAI REST API

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
            let completeMessage = '';
        
            incomingMessage.on('data', data => {
                const events = data.toString().split('\n');
        
                events.forEach(event => {
                    eventCount++;
        
                    if (event.trim() === '') return;

                    if (event.trim() === 'data: [DONE]') {
                        t.truthy(eventCount > 1);
                        console.log('\n=== Complete Message ===');
                        console.log(completeMessage);
                        console.log('========================\n');
                        resolve(completeMessage);
                        return;
                    }
        
                    const message = event.replace(/^data: /, '');
                    const messageJson = JSON.parse(message);
                    
                    // Collect streaming content
                    if (messageJson.choices && messageJson.choices[0] && messageJson.choices[0].delta && messageJson.choices[0].delta.content) {
                        completeMessage += messageJson.choices[0].delta.content;
                    }
                    
                    customAssertions(t, messageJson);
                });
            });  
        
        } catch (error) {
            console.error('Error connecting to SSE endpoint:', error);
            reject(error);
        }
    });
}

test('POST SSE: /v1/chat/completions should stream text response from Grok-4', async (t) => {
    const payload = {
        model: 'grok-4',
        messages: [
            {
                role: 'user',
                content: 'Hello! Please introduce yourself.',
            },
        ],
        stream: true,
    };
    
    const url = `http://localhost:${process.env.CORTEX_PORT}/v1`;
    
    const grokStreamingAssertions = (t, messageJson) => {
        t.truthy(messageJson.id);
        t.is(messageJson.object, 'chat.completion.chunk');
        t.truthy(messageJson.choices[0].delta);
        t.truthy(messageJson.choices[0].finish_reason === null || messageJson.choices[0].finish_reason === 'stop');
    };
    
    const completeMessage = await connectToSSEEndpoint(url, '/chat/completions', payload, t, grokStreamingAssertions);
    
    // Additional assertions on the complete message
    t.truthy(completeMessage);
    t.true(completeMessage.length > 0);
    console.log(`Complete message length: ${completeMessage.length} characters`);
});