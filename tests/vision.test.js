// vision.test.js
// This is where all the Cortex vision model tests go

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

test('vision test image', async t => {
    const response = await testServer.executeOperation({
        query: `query($text: String, $chatHistory: [MultiMessage]){
            vision(text: $text, chatHistory: $chatHistory) {
              result
            }
          }`,

          variables: {
            "chatHistory": [
              { 
                "role": "user",
                "content": [
                  "{\"type\": \"text\", \"text\": \"first tell me your name then describe the image shortly:\"}",
                  "{\"type\":\"image_url\",\"image_url\":{\"url\":\"https://static.toiimg.com/thumb/msid-102827471,width-1280,height-720,resizemode-4/102827471.jpg\"}}"
                ],
            }],
        },
    });

    t.is(response.body?.singleResult?.errors, undefined);
    const result = response.body?.singleResult?.data?.vision.result;
    t.true(result.length > 100);
    t.true(result.toLowerCase().includes('chess'), 'Response should mention chess');
    t.true(result.toLowerCase().includes('board'), 'Response should mention a board');
});


test('vision test base64 image', async t => {
    const response = await testServer.executeOperation({
        query: `query($text: String, $chatHistory: [MultiMessage]){
            vision(text: $text, chatHistory: $chatHistory) {
              result
            }
          }`,

          variables: {
            "chatHistory": [
              { 
                "role": "user",
                "content": [
                  "{\"type\": \"text\", \"text\": \"first tell me your name then describe the image shortly:\"}",
                  "{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:image/jpeg;base64,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\"}}"
                ],
            }],
        },
    });

    t.is(response.body?.singleResult?.errors, undefined);
    const result = response.body?.singleResult?.data?.vision.result;
    t.true(result.length > 100);
    t.true( result.toLowerCase().includes('soccer') ||
            result.toLowerCase().includes('uniform') ||
            result.toLowerCase().includes('sport'), 'Response should mention either soccer or uniform or sport');
});


const base64Img = `data:image/jpeg;base64,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`;

test('vision test chunking', async t => {
    t.timeout(400000);
    //generate text adem1 adem2 ... ademN
    // const testText = Array.from(Array(1000000).keys()).map(i => `adem${i}`).join(' ');
    //const testRow = { "role": "user", "content": [`{"type": "text", "text": "${testText}"}`] };

    const base64ImgRow = `{"type":"image_url","image_url":{"url":"${base64Img}"}}`;

    const response = await testServer.executeOperation({
        query: `query($text: String, $chatHistory: [MultiMessage]){
            vision(text: $text, chatHistory: $chatHistory) {
              result
            }
          }`,

          variables: {
            "chatHistory": [
              { 
                "role": "user",
                "content": [
                  "{\"type\": \"text\", \"text\": \"first tell me your name then describe the image shortly:\"}",
                  ...Array.from(new Array(1),()=> base64ImgRow),
                ],
            }],
        },
    });

    t.is(response.body?.singleResult?.errors, undefined);
    const result = response.body?.singleResult?.data?.vision.result;
    t.true(result.length > 100);  
    t.true(result.toLowerCase().includes('soccer') || 
            result.toLowerCase().includes('uniform') ||
            result.toLowerCase().includes('sport'), 'Response should mention either soccer or uniform or sport');
});

test('vision multi long text', async t => {
    t.timeout(400000);
    //generate text adem1 adem2 ... ademN
    const testText = Array.from(Array(10).keys()).map(i => `adem${i}`).join(' ');
    const testRow = { "role": "user", "content": [`{"type": "text", "text": "${testText}"}`] };

    const base64ImgRow = `{"type":"image_url","image_url":{"url":"${base64Img}"}}`;

    const response = await testServer.executeOperation({
        query: `query($text: String, $chatHistory: [MultiMessage]){
            vision(text: $text, chatHistory: $chatHistory) {
              result
            }
          }`,

          variables: {
            "chatHistory": [
              ...Array.from(new Array(10),()=> testRow),
              { 
                "role": "user",
                "content": [
                  "{\"type\": \"text\", \"text\": \"first tell me your name then describe the image shortly:\"}",
                  ...Array.from(new Array(10),()=> base64ImgRow),
                ],
              },
              { 
                "role": "user",
                "content": [
                  "{\"type\": \"text\", \"text\": \"then tell me your name then describe the image shortly:\"}",
                  ...Array.from(new Array(1),()=> base64ImgRow),
                ],
              },
            ],
        },
    });

    t.is(response.body?.singleResult?.errors, undefined);
    const result = response.body?.singleResult?.data?.vision.result;
    t.true(result.length > 100);
    t.true(result.toLowerCase().includes('soccer') || 
            result.toLowerCase().includes('uniform') ||
            result.toLowerCase().includes('sport'), 'Response should mention either soccer or uniform or sport');
});
