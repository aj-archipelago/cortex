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
            let accumulatedContent = '';
            let hasContent = false;
            let finalResponse = null;
            let liveSearchData = {
                citations: [],
                search_queries: [],
                web_search_results: [],
                real_time_data: []
            };
        
            incomingMessage.on('data', data => {
                const events = data.toString().split('\n');
        
                events.forEach(event => {
                    eventCount++;
        
                    if (event.trim() === '') return;

                    if (event.trim() === 'data: [DONE]') {
                        t.truthy(eventCount > 1);
                        // Check final accumulated content for sanity
                        if (hasContent) {
                            t.truthy(accumulatedContent.length > 0, 'Should have accumulated some content');
                            t.truthy(accumulatedContent.trim().length > 10, 'Accumulated content should be substantial');
                        }
                        
                        // Show final response and live search data
                        console.log('\n=== FINAL RESPONSE ===');
                        console.log('Accumulated Content:', accumulatedContent);
                        console.log('\n=== LIVE SEARCH DATA ===');
                        console.log('Citations:', JSON.stringify(liveSearchData.citations, null, 2));
                        console.log('Search Queries:', JSON.stringify(liveSearchData.search_queries, null, 2));
                        console.log('Web Search Results:', JSON.stringify(liveSearchData.web_search_results, null, 2));
                        console.log('Real-time Data:', JSON.stringify(liveSearchData.real_time_data, null, 2));
                        console.log('Total Events Processed:', eventCount);
                        console.log('Events with Content:', hasContent ? 'Yes' : 'No');
                        console.log('========================\n');
                        
                        resolve();
                        return;
                    }
        
                    // Skip events that don't have meaningful content (content, citations, search_queries, etc.)
                    if (event.includes('content') || event.includes('citations') || 
                        event.includes('search_queries') || event.includes('web_search_results') ||
                        event.includes('real_time_data')) {
                        
                        // Debug: Log the raw event to see what we're getting
                        if (event.includes('citations') || event.includes('search_queries') || 
                            event.includes('web_search_results') || event.includes('real_time_data')) {
                            console.log('DEBUG: Found live search event:', event.substring(0, 200) + '...');
                        }
                        
                        const message = event.replace(/^data: /, '');
                        const messageJson = JSON.parse(message);
                        
                        // Debug: Log the full message structure for live search events
                        if (messageJson.citations || messageJson.search_queries || 
                            messageJson.web_search_results || messageJson.real_time_data) {
                            console.log('DEBUG: Full message with live search data:', JSON.stringify(messageJson, null, 2));
                        }
                        
                        // Accumulate content and live search data
                        const delta = messageJson.choices?.[0]?.delta;
                        if (delta?.content) {
                            accumulatedContent += delta.content;
                            hasContent = true;
                        }
                        
                        // Store the final response for display
                        finalResponse = messageJson;
                        
                        // Accumulate live search data
                        if (messageJson.citations) {
                            liveSearchData.citations.push(...(Array.isArray(messageJson.citations) ? messageJson.citations : [messageJson.citations]));
                        }
                        if (messageJson.search_queries) {
                            liveSearchData.search_queries.push(...(Array.isArray(messageJson.search_queries) ? messageJson.search_queries : [messageJson.search_queries]));
                        }
                        if (messageJson.web_search_results) {
                            liveSearchData.web_search_results.push(...(Array.isArray(messageJson.web_search_results) ? messageJson.web_search_results : [messageJson.web_search_results]));
                        }
                        if (messageJson.real_time_data) {
                            liveSearchData.real_time_data.push(...(Array.isArray(messageJson.real_time_data) ? messageJson.real_time_data : [messageJson.real_time_data]));
                        }
                        
                        // Also check delta for live search data
                        if (delta?.citations) {
                            liveSearchData.citations.push(...(Array.isArray(delta.citations) ? delta.citations : [delta.citations]));
                        }
                        if (delta?.search_queries) {
                            liveSearchData.search_queries.push(...(Array.isArray(delta.search_queries) ? delta.search_queries : [delta.search_queries]));
                        }
                        if (delta?.web_search_results) {
                            liveSearchData.web_search_results.push(...(Array.isArray(delta.web_search_results) ? delta.web_search_results : [delta.web_search_results]));
                        }
                        if (delta?.real_time_data) {
                            liveSearchData.real_time_data.push(...(Array.isArray(delta.real_time_data) ? delta.real_time_data : [delta.real_time_data]));
                        }
                        
                        customAssertions(t, messageJson);
                    }
                });
            });  
        
        } catch (error) {
            console.error('Error connecting to SSE endpoint:', error);
            reject(error);
        }
    });
}

test('POST SSE: /v1/chat/completions with grok-4 should send streaming events with Live Search data', async (t) => {
    t.timeout(120000);
    
    const payload = {
        model: 'grok-4',
        messages: [
            {
                role: 'user',
                content: 'What are the latest news about AI developments today? Please search for recent information.'
            }
        ],
        web_search: true,
        real_time_data: true,
        return_citations: true,
        max_search_results: 10,
        sources: ['web', 'x', 'news'],
        stream: true
    };
    
    const url = `http://localhost:${process.env.CORTEX_PORT}/v1`;
    
    const grokStreamingAssertions = (t, messageJson) => {
        t.truthy(messageJson.id);
        t.is(messageJson.object, 'chat.completion.chunk');
        t.truthy(messageJson.choices[0].delta);
        t.truthy(messageJson.choices[0].finish_reason === null || messageJson.choices[0].finish_reason === 'stop');
        
        // Check for Grok-specific fields in streaming response (no logging)
        if (messageJson.citations || messageJson.search_queries || 
            messageJson.web_search_results || messageJson.real_time_data) {
            t.truthy(messageJson.citations || messageJson.search_queries || 
                messageJson.web_search_results || messageJson.real_time_data, 
                'Should have Live Search data in stream event');
        }
        
        // Check for Grok-specific fields in delta (no logging)
        const delta = messageJson.choices?.[0]?.delta;
        if (delta?.citations || delta?.search_queries || 
            delta?.web_search_results || delta?.real_time_data) {
            t.truthy(delta.citations || delta.search_queries || 
                delta.web_search_results || delta.real_time_data, 
                'Should have Live Search data in delta');
        }
    };
    
    await connectToSSEEndpoint(url, '/chat/completions', payload, t, grokStreamingAssertions);
});

test('POST SSE: /v1/chat/completions with grok-4 should handle multimodal content', async (t) => {
    t.timeout(120000);
    
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
                            url: 'https://static.toiimg.com/thumb/msid-102827471,width-1280,height-720,resizemode-4/102827471.jpg'
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
        
        // Check for content in delta (no logging - content is accumulated)
        const delta = messageJson.choices?.[0]?.delta;
        if (delta?.content) {
            t.truthy(delta.content, 'Should have content in delta');
        }
    };
    
    await connectToSSEEndpoint(url, '/chat/completions', payload, t, grokMultimodalAssertions);
}); 