import test from 'ava';
import Claude3VertexPlugin from '../server/plugins/claude3VertexPlugin.js';
import { mockPathwayResolverMessages } from './mocks.js';
import { config } from '../config.js';
import fs from 'fs';
import path from 'path';

// Helper function to load test data from files
function loadTestData(filename) {
  try {
    const filePath = path.join(process.cwd(), 'tests', 'data', filename);
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    console.error(`Error loading test data file ${filename}:`, error);
    // Return a smaller fallback test string if file loading fails
    return 'a '.repeat(1000); 
  }
}

const { pathway, model } = mockPathwayResolverMessages;

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

    const result = await plugin.getRequestParameters(text, parameters, prompt);
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

test('getRequestParameters with long message in chatHistory', async (t) => {
    const plugin = new Claude3VertexPlugin(pathway, model);
    const text = 'Final message';
    
    // Load long content from file
    const longContent = loadTestData('largecontent.txt');
    
    // Set up chatHistory with a long message
    const chatHistory = [
        { role: 'user', content: 'Short message' },
        { role: 'assistant', content: 'Short response' },
        { role: 'user', content: longContent },
        { role: 'assistant', content: 'Long content response' },
        { role: 'user', content: 'Final message' }
    ];
    
    // Create a custom prompt that includes the chatHistory
    const prompt = {
        ...mockPathwayResolverMessages.pathway.prompt,
        messages: chatHistory
    };
    
    const parameters = { stream: false };
    plugin.promptParameters.manageTokenLength = true;

    const result = await plugin.getRequestParameters(text, parameters, prompt);
    
    // Verify we have messages in the result
    t.truthy(result.messages);
    
    // Check that the long message was truncated (should be shorter than original)
    const userMessages = result.messages.filter(msg => 
        msg.role === 'user' && 
        msg.content[0].type === 'text'
    );
    
    // Verify we have user messages in the result
    t.true(userMessages.length > 0, 'Should include user messages');
    
    // Find the long message that was truncated
    const longMessage = userMessages.find(msg => 
        msg.content[0].text.length < longContent.length && 
        msg.content[0].text.length > 100  // Ensure it's the long message, not other short ones
    );
    
    // Verify the long message was truncated
    t.truthy(longMessage, 'Long user message should be truncated');
    t.true(longMessage.content[0].text.length < longContent.length, 'Truncated message should be shorter than original');
    
    // Verify the final user input message is included
    const finalInputMessage = result.messages.find(msg => 
        msg.role === 'user' && 
        msg.content[0].type === 'text' && 
        msg.content[0].text.includes(text)
    );
    
    t.truthy(finalInputMessage, 'Final user input should be included');
    
    // Log token counts for debugging/verification
    console.log(`Original content length: ${longContent.length} chars`);
    console.log(`Truncated content length: ${longMessage.content[0].text.length} chars`);
});

test('parseResponse', (t) => {
    const plugin = new Claude3VertexPlugin(pathway, model);

    // Test text content response
    const dataWithTextContent = {
        content: [
            { type: 'text', text: 'Hello, World!' }
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: 'end_turn'
    };
    const resultWithTextContent = plugin.parseResponse(dataWithTextContent);
    t.truthy(resultWithTextContent.output_text === 'Hello, World!');
    t.truthy(resultWithTextContent.finishReason === 'stop');
    t.truthy(resultWithTextContent.usage);
    t.truthy(resultWithTextContent.metadata.model === plugin.modelName);

    // Test tool calls response
    const dataWithToolCalls = {
        content: [
            { 
                type: 'tool_use', 
                id: 'tool_1',
                name: 'search_web',
                input: { query: 'test search' }
            }
        ],
        usage: { input_tokens: 15, output_tokens: 8 },
        stop_reason: 'tool_use'
    };
    const resultWithToolCalls = plugin.parseResponse(dataWithToolCalls);
    t.truthy(resultWithToolCalls.output_text === '');
    t.truthy(resultWithToolCalls.finishReason === 'tool_calls');
    t.truthy(resultWithToolCalls.toolCalls);
    t.truthy(resultWithToolCalls.toolCalls.length === 1);
    t.truthy(resultWithToolCalls.toolCalls[0].id === 'tool_1');
    t.truthy(resultWithToolCalls.toolCalls[0].function.name === 'search_web');
    t.truthy(resultWithToolCalls.toolCalls[0].function.arguments === '{"query":"test search"}');

    // Test data without content (should return original data)
    const dataWithoutContent = {};
    const resultWithoutContent = plugin.parseResponse(dataWithoutContent);
    t.deepEqual(resultWithoutContent, dataWithoutContent);

    // Test null data (should return null)
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
  const messages = [{ role: 'user', content: { type: 'image_url', image_url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf' } }];
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

test('convertMessagesToClaudeVertex with multi-part content array', async (t) => {
  const plugin = new Claude3VertexPlugin(pathway, model);
  
  // Test with multi-part content array
  const multiPartContent = [
    {
      type: 'text', 
      text: 'Hello world'
    },
    {
      type: 'text', 
      text: 'Hello2 world2'
    },
    {
      type: 'image_url', 
      image_url: 'https://static.toiimg.com/thumb/msid-102827471,width-1280,height-720,resizemode-4/102827471.jpg'
    }
  ];
  
  const messages = [
    { role: 'system', content: 'System message' },
    { role: 'user', content: multiPartContent }
  ];
  
  const output = await plugin.convertMessagesToClaudeVertex(messages);
  
  // Verify system message is preserved
  t.is(output.system, 'System message');
  
  // Verify the user message role is preserved
  t.is(output.modifiedMessages[0].role, 'user');
  
  // Verify the content array has the correct number of items
  // We expect 3 items: 2 text items and 1 image item
  t.is(output.modifiedMessages[0].content.length, 3);
  
  // Verify the text content items
  t.is(output.modifiedMessages[0].content[0].type, 'text');
  t.is(output.modifiedMessages[0].content[0].text, 'Hello world');
  
  t.is(output.modifiedMessages[0].content[1].type, 'text');
  t.is(output.modifiedMessages[0].content[1].text, 'Hello2 world2');
  
  // Verify the image content item
  t.is(output.modifiedMessages[0].content[2].type, 'image');
  t.is(output.modifiedMessages[0].content[2].source.type, 'base64');
  t.is(output.modifiedMessages[0].content[2].source.media_type, 'image/jpeg');
  
  // Check if the base64 data looks reasonable
  const base64Data = output.modifiedMessages[0].content[2].source.data;
  const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
  t.true(base64Data.length > 100); // Check if the data is sufficiently long
  t.true(base64Regex.test(base64Data)); // Check if the data matches the base64 regex
});