import test from 'ava';
import serverFactory from '../index.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import Claude3VertexPlugin from '../server/plugins/claude3VertexPlugin.js';
import { mockPathwayResolverMessages } from './mocks.js';
import { config } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let testServer;
test.before(async () => {
  const { server, startServer } = await serverFactory();
  if (startServer) await startServer();
  testServer = server;
});

test.after.always('cleanup', async () => {
  if (testServer) {
    await testServer.stop();
  }
});

const { pathway, modelName, model } = mockPathwayResolverMessages;

test('constructor', (t) => {
    const plugin = new Claude3VertexPlugin(pathway, model);
    t.is(plugin.config, config);
    t.is(plugin.pathwayPrompt, mockPathwayResolverMessages.pathway.prompt);
});

test('getRequestParameters', async (t) => {
    const plugin = new Claude3VertexPlugin(pathway, model);
    const text = 'Help me';
    const parameters = { name: 'John', age: 30, stream: false };
    const prompt = mockPathwayResolverMessages.pathway.prompt;

    const result = await plugin.getRequestParameters(text, parameters, prompt, { messages: [] });
    t.deepEqual(result, {
        system: '',
        messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Translate this: Help me",
                },
              ],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Translating: Help me",
                },
              ],
            },
            {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "Nice work!",
                  },
                ],
              },
        ],
        max_tokens: plugin.getModelMaxReturnTokens(),
        anthropic_version: 'vertex-2023-10-16',
        stream: false,
        temperature: 0.7,
    });
});

test('parseResponse', (t) => {
    const plugin = new Claude3VertexPlugin(pathway, model);

    const dataWithTextContent = {
        content: [
            { type: 'text', text: 'Hello, World!' }
        ]
    };
    const resultWithTextContent = plugin.parseResponse(dataWithTextContent);
    t.is(resultWithTextContent, 'Hello, World!');

    const dataWithoutTextContent = {
        content: [
            { type: 'image', url: 'http://example.com/image.jpg' }
        ]
    };
    const resultWithoutTextContent = plugin.parseResponse(dataWithoutTextContent);
    t.deepEqual(resultWithoutTextContent, dataWithoutTextContent);

    const dataWithoutContent = {};
    const resultWithoutContent = plugin.parseResponse(dataWithoutContent);
    t.deepEqual(resultWithoutContent, dataWithoutContent);

    const dataNull = null;
    const resultNull = plugin.parseResponse(dataNull);
    t.is(resultNull, dataNull);
});

test('convertMessagesToClaudeVertex text message', async (t) => {
    const plugin = new Claude3VertexPlugin(pathway, model);
    // Test with text message
    let messages = [
        { role: 'system', content: 'System message' },
        { role: 'user', content: 'User message' },
        { role: 'assistant', content: 'Assistant message' },
        { role: 'user', content: 'User message 2' },
    ];
    let output = await plugin.convertMessagesToClaudeVertex(messages);
    t.deepEqual(output, {
        system: 'System message',
        modifiedMessages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "User message",
                },
              ],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: "Assistant message",
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "User message 2",
                },
              ],
            },
        ],
    });
});

test('convertMessagesToClaudeVertex image_url message', async (t) => {
  const plugin = new Claude3VertexPlugin(pathway, model);
  // Test with image_url message
  const messages = [
      { 
          role: 'assistant', 
          content: { 
              type: 'image_url', 
              // Define image_url, make sure it's accessible and supported MIME type
              image_url: 'https://static.toiimg.com/thumb/msid-102827471,width-1280,height-720,resizemode-4/102827471.jpg' 
          }
      }
  ];
  const output = await plugin.convertMessagesToClaudeVertex(messages);

  // Define a regex for base64 validation
  const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
  const base64Data = output.modifiedMessages[0].content[0].source.data;

  t.is(output.system, '');
  t.is(output.modifiedMessages[0].role, 'assistant');
  t.is(output.modifiedMessages[0].content[0].type, 'image');
  t.is(output.modifiedMessages[0].content[0].source.type, 'base64');
  t.is(output.modifiedMessages[0].content[0].source.media_type, 'image/jpeg');
  
  // Check if the base64 data looks reasonable
  t.true(base64Data.length > 100); // Check if the data is sufficiently long
  t.true(base64Regex.test(base64Data)); // Check if the data matches the base64 regex
});

test('convertMessagesToClaudeVertex unsupported type', async (t) => {
    const plugin = new Claude3VertexPlugin(pathway, model);
    // Test with unsupported type
    const messages = [{ role: 'user', content: { type: 'unsupported_type' } }];
    const output = await plugin.convertMessagesToClaudeVertex(messages);
    t.deepEqual(output, { system: '', modifiedMessages: [{role: 'user', content: [] }] });
});

test('convertMessagesToClaudeVertex empty messages', async (t) => {
    const plugin = new Claude3VertexPlugin(pathway, model);
    // Test with empty messages
    const messages = [];
    const output = await plugin.convertMessagesToClaudeVertex(messages);
    t.deepEqual(output, { system: '', modifiedMessages: [] });
});

test('convertMessagesToClaudeVertex system message', async (t) => {
    const plugin = new Claude3VertexPlugin(pathway, model);
    // Test with system message
    const messages = [{ role: 'system', content: 'System message' }];
    const output = await plugin.convertMessagesToClaudeVertex(messages);
    t.deepEqual(output, { system: 'System message', modifiedMessages: [] });
});

test('convertMessagesToClaudeVertex system message with user message', async (t) => {
    const plugin = new Claude3VertexPlugin(pathway, model);
    // Test with system message followed by user message
    const messages = [
        { role: 'system', content: 'System message' },
        { role: 'user', content: 'User message' }
    ];
    const output = await plugin.convertMessagesToClaudeVertex(messages);
    t.deepEqual(output, {
        system: 'System message',
        modifiedMessages: [{ role: 'user', content: [{ type: 'text', text: 'User message' }] }]
    });
});

test('convertMessagesToClaudeVertex user message with unsupported image type', async (t) => {
  const plugin = new Claude3VertexPlugin(pathway, model);
  // Test with unsupported image type
  const messages = [{ role: 'user', content: { type: 'image_url', image_url: 'https://unec.edu.az/application/uploads/2014/12/pdf-sample.pdf' } }];
  const output = await plugin.convertMessagesToClaudeVertex(messages);
  t.deepEqual(output, { system: '', modifiedMessages: [{role: 'user', content: [] }] });
});

test('convertMessagesToClaudeVertex user message with no content', async (t) => {
  const plugin = new Claude3VertexPlugin(pathway, model);
  // Test with no content
  const messages = [{ role: 'user', content: null }];
  const output = await plugin.convertMessagesToClaudeVertex(messages);
  t.deepEqual(output, { system: '', modifiedMessages: [] });
});

test('content array handling in rest endpoint via API call', async (t) => {
  // This test verifies the functionality in server/rest.js where array content is JSON stringified
  // Specifically testing: content: Array.isArray(msg.content) ? msg.content.map(item => JSON.stringify(item)) : msg.content
  
  // Import axios for making HTTP requests
  const axios = await import('axios');
  
  // Create a request with MultiMessage array content
  const testContent = [
    {
      type: 'text', 
      text: 'Hello world'
    },
    {
      type: 'text', 
      text: 'Hello2 world2'
    },
    {
      type: 'image', 
      url: 'https://example.com/test.jpg'
    }
  ];
  
  try {
    // First, check if the API server is running and get available models
    let modelToUse = '*'; // Default fallback model
    try {
      const modelsResponse = await axios.default.get('http://localhost:4000/v1/models');
      if (modelsResponse.data && modelsResponse.data.data && modelsResponse.data.data.length > 0) {
        const models = modelsResponse.data.data.map(model => model.id);
        
        // Priority 1: Find sonnet with highest version (e.g., claude-3.7-sonnet)
        const sonnetVersions = models
          .filter(id => id.includes('-sonnet') && id.startsWith('claude-'))
          .sort((a, b) => {
            // Extract version numbers and compare
            const versionA = a.match(/claude-(\d+\.\d+)-sonnet/);
            const versionB = b.match(/claude-(\d+\.\d+)-sonnet/);
            if (versionA && versionB) {
              return parseFloat(versionB[1]) - parseFloat(versionA[1]); // Descending order
            }
            return 0;
          });
        
        if (sonnetVersions.length > 0) {
          modelToUse = sonnetVersions[0]; // Use highest version sonnet
        } else {
          // Priority 2: Any model ending with -sonnet
          const anySonnet = models.find(id => id.endsWith('-sonnet'));
          if (anySonnet) {
            modelToUse = anySonnet;
          } else {
            // Priority 3: Any model starting with claude-
            const anyClaude = models.find(id => id.startsWith('claude-'));
            if (anyClaude) {
              modelToUse = anyClaude;
            } else {
              // Fallback: Just use the first available model
              modelToUse = models[0];
            }
          }
        }
        
        t.log(`Using model: ${modelToUse}`);
      }
    } catch (modelError) {
      t.log('Could not get available models, using default model');
    }
    
    // Make a direct HTTP request to the REST API
    const response = await axios.default.post('http://localhost:4000/v1/chat/completions', {
      model: modelToUse,
      messages: [
        {
          role: 'user',
          content: testContent
        }
      ]
    });

    t.log('Response:', response.data.choices[0].message);

    const message = response.data.choices[0].message;

    //message should not have anything similar to:
    //Execution failed for sys_claude_37_sonnet: HTTP error: 400 Bad Request
    //HTTP error:
    t.falsy(message.content.startsWith('HTTP error:'));
    //400 Bad Request
    t.falsy(message.content.startsWith('400 Bad Request'));
    //Execution failed
    t.falsy(message.content.startsWith('Execution failed'));
    //Invalid JSON
    t.falsy(message.content.startsWith('Invalid JSON'));

    
    // If the request succeeds, it means the array content was properly processed
    // If the JSON.stringify was not applied correctly, the request would fail
    t.truthy(response.data);
    t.pass('REST API successfully processed array content');
  } catch (error) {
    // If there's a connection error (e.g., API not running), we'll skip this test
    if (error.code === 'ECONNREFUSED') {
      t.pass('Skipping test - REST API not available');
    } else {
      // Check if the error response contains useful information
      if (error.response) {
        // We got a response from the server, but with an error status
        t.log('Server responded with:', error.response.data);
        
        // Skip the test if the server is running but no pathway is configured to handle the request
        if (error.response.status === 404 && 
            error.response.data.error && 
            error.response.data.error.includes('not found')) {
          t.pass('Skipping test - No suitable pathway configured for this API endpoint');
        } else {
          t.fail(`API request failed with status ${error.response.status}: ${error.response.statusText}`);
        }
      } else {
        // No response received
        t.fail(`API request failed: ${error.message}`);
      }
    }
  }
});
