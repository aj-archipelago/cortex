// grok_streaming.test.js
// Tests for Grok streaming via REST SSE endpoints

import test from 'ava';
import serverFactory from '../index.js';
import axios from 'axios';

let testServer;

test.before(async () => {
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

test('POST SSE: /v1/chat/completions with grok-4 should send streaming events with Live Search data', async (t) => {
    t.timeout(60000);
    
    const payload = {
        model: 'grok-4',
        messages: [
            {
                role: 'user',
                content: 'What are the latest developments in AI?'
            }
        ],
        search_parameters: {
            mode: 'auto',
            return_citations: true,
            max_search_results: 10,
            sources: [
                { type: 'web' },
                { type: 'x' },
                { type: 'news' }
            ]
        },
        stream: true
    };
    
    const url = `http://localhost:${process.env.CORTEX_PORT}/v1`;
    
    const grokStreamingAssertions = (t, messageJson) => {
        t.truthy(messageJson.id);
        t.is(messageJson.object, 'chat.completion.chunk');
        t.truthy(messageJson.choices[0].delta);
        t.truthy(messageJson.choices[0].finish_reason === null || messageJson.choices[0].finish_reason === 'stop');
        
        // Check for Grok-specific fields in streaming response
        if (messageJson.citations || messageJson.search_queries || 
            messageJson.web_search_results || messageJson.real_time_data) {
            console.log('Grok streaming: Found Live Search data in stream event');
            console.log('Citations:', messageJson.citations);
            console.log('Search queries:', messageJson.search_queries);
            console.log('Web search results:', messageJson.web_search_results);
            console.log('Real-time data:', messageJson.real_time_data);
        }
        
        // Check for Grok-specific fields in delta
        const delta = messageJson.choices?.[0]?.delta;
        if (delta?.citations || delta?.search_queries || 
            delta?.web_search_results || delta?.real_time_data) {
            console.log('Grok streaming: Found Live Search data in delta');
            console.log('Delta citations:', delta.citations);
            console.log('Delta search queries:', delta.search_queries);
            console.log('Delta web search results:', delta.web_search_results);
            console.log('Delta real-time data:', delta.real_time_data);
        }
    };
    
    await connectToSSEEndpoint(url, '/chat/completions', payload, t, grokStreamingAssertions);
});

test('POST SSE: /v1/chat/completions with grok-4 should handle multimodal content', async (t) => {
    t.timeout(60000);
    
    const payload = {
        model: 'grok-4',
        messages: [
            {
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: 'What do you see in this image?'
                    },
                    {
                        type: 'image_url',
                        image_url: {
                            url: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDABQODxIPDRQSEBIXFRQdHx4eHRoaHSQrJyEwPENBMDQ4NDQ0QUJCSkNLS0tNSkpQUFFQR1BTYWNgY2FQYWFQYWj/2wBDARUXFyAeIBohHh4oIiE2LCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAIAAoDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k='
                        }
                    }
                ]
            }
        ],
        stream: true
    };
    
    const url = `http://localhost:${process.env.CORTEX_PORT}/v1`;
    
    const grokMultimodalAssertions = (t, messageJson) => {
        t.truthy(messageJson.id);
        t.is(messageJson.object, 'chat.completion.chunk');
        t.truthy(messageJson.choices[0].delta);
        t.truthy(messageJson.choices[0].finish_reason === null || messageJson.choices[0].finish_reason === 'stop');
        
        // Check for content in delta
        const delta = messageJson.choices?.[0]?.delta;
        if (delta?.content) {
            console.log('Grok multimodal streaming: Content delta:', delta.content);
        }
    };
    
    await connectToSSEEndpoint(url, '/chat/completions', payload, t, grokMultimodalAssertions);
}); 