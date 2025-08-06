// test_bing_agent.js
// This is where all the Cortex bing agent tests go

import test from 'ava';
import serverFactory from '../index.js';

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

test('bing agent basic query', async t => {
    const response = await testServer.executeOperation({
        query: `query($text: String){
            bing_agent(text: $text) {
              result
            }
          }`,

          variables: {
            "text": "What is the capital of France?"
          },
    });

    t.is(response.body?.singleResult?.errors, undefined);
    const result = response.body?.singleResult?.data?.bing_agent.result;
    t.true(result && result.length > 0, 'Response should not be empty');
    t.true(result.toLowerCase().includes('paris'), 'Response should mention Paris');
});

test('bing agent weather query', async t => {
    const response = await testServer.executeOperation({
        query: `query($text: String){
            bing_agent(text: $text) {
              result
            }
          }`,

          variables: {
            "text": "What is the current weather in New York?"
          },
    });

    t.is(response.body?.singleResult?.errors, undefined);
    const result = response.body?.singleResult?.data?.bing_agent.result;
    t.true(result.length > 50);
    t.true(result.toLowerCase().includes('weather') || 
           result.toLowerCase().includes('temperature') || 
           result.toLowerCase().includes('new york'), 'Response should mention weather, temperature, or New York');
});

test('bing agent news query', async t => {
    const response = await testServer.executeOperation({
        query: `query($text: String){
            bing_agent(text: $text) {
              result
            }
          }`,

          variables: {
            "text": "What is the latest news about technology?"
          },
    });

    t.is(response.body?.singleResult?.errors, undefined);
    const result = response.body?.singleResult?.data?.bing_agent.result;
    t.true(result.length > 50);
    t.true(result.toLowerCase().includes('technology') || 
           result.toLowerCase().includes('news') || 
           result.toLowerCase().includes('latest'), 'Response should mention technology, news, or latest');
});

test('bing agent sports query', async t => {
    const response = await testServer.executeOperation({
        query: `query($text: String){
            bing_agent(text: $text) {
              result
            }
          }`,

          variables: {
            "text": "Who won the last World Cup?"
          },
    });

    t.is(response.body?.singleResult?.errors, undefined);
    const result = response.body?.singleResult?.data?.bing_agent.result;
    t.true(result.length > 50);
    t.true(result.toLowerCase().includes('world cup') || 
           result.toLowerCase().includes('soccer') || 
           result.toLowerCase().includes('football'), 'Response should mention World Cup, soccer, or football');
});

test('bing agent population query', async t => {
    const response = await testServer.executeOperation({
        query: `query($text: String){
            bing_agent(text: $text) {
              result
            }
          }`,

          variables: {
            "text": "What is the population of Tokyo?"
          },
    });

    t.is(response.body?.singleResult?.errors, undefined);
    const result = response.body?.singleResult?.data?.bing_agent.result;
    t.true(result.length > 50);
    t.true(result.toLowerCase().includes('tokyo') || 
           result.toLowerCase().includes('population') || 
           result.toLowerCase().includes('million'), 'Response should mention Tokyo, population, or million');
});

test('bing agent timeout handling', async t => {
    t.timeout(60000); // 60 second timeout for this test
    
    const response = await testServer.executeOperation({
        query: `query($text: String){
            bing_agent(text: $text) {
              result
            }
          }`,

          variables: {
            "text": "What is the meaning of life?"
          },
    });

    t.is(response.body?.singleResult?.errors, undefined);
    const result = response.body?.singleResult?.data?.bing_agent.result;
    t.true(result.length > 50);
    t.true(result.toLowerCase().includes('life') || 
           result.toLowerCase().includes('meaning') || 
           result.toLowerCase().includes('philosophy'), 'Response should mention life, meaning, or philosophy');
}); 