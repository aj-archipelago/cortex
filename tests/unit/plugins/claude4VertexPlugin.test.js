import test from 'ava';
import Claude4VertexPlugin from '../../../server/plugins/claude4VertexPlugin.js';
import { mockPathwayResolverMessages } from '../../helpers/mocks.js';
import { config } from '../../../config.js';
import fs from 'fs';
import path from 'path';

// Helper function to load test data from files
function loadTestData(filename) {
  try {
    const filePath = path.join(process.cwd(), 'tests', 'data', filename);
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    // Throw error to make test failures explicit when required data is missing
    throw new Error(`Failed to load required test data file ${filename}: ${error.message}`);
  }
}

const { pathway, model } = mockPathwayResolverMessages;

test('constructor', (t) => {
    const plugin = new Claude4VertexPlugin(pathway, model);
    t.is(plugin.config, config);
    t.is(plugin.pathwayPrompt, mockPathwayResolverMessages.pathway.prompt);
    t.true(plugin.isMultiModal);
});

test('parseResponse', (t) => {
    const plugin = new Claude4VertexPlugin(pathway, model);

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
    const plugin = new Claude4VertexPlugin(pathway, model);
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
  const plugin = new Claude4VertexPlugin(pathway, model);
  // Test with image_url message
  const messages = [
      { 
          role: 'assistant', 
          content: { 
              type: 'image_url', 
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

test('convertMessagesToClaudeVertex stringified JSON PDF (real-world format)', async (t) => {
  const plugin = new Claude4VertexPlugin(pathway, model);
  
  // Test with stringified JSON PDF content (how it actually comes from the system)
  const base64Pdf = Buffer.from('Sample PDF content').toString('base64');
  const stringifiedPdf = JSON.stringify({
    type: 'image_url',
    url: 'data:application/pdf;base64,' + base64Pdf,
    image_url: { url: 'data:application/pdf;base64,' + base64Pdf },
    originalFilename: 'Invoice.pdf'
  });
  
  const messages = [
      {
          role: 'user',
          content: [
              {
                  type: 'text',
                  text: 'Please analyze this document'
              },
              {
                  type: 'text',
                  text: stringifiedPdf // Content item is stringified JSON
              }
          ]
      }
  ];
  
  const output = await plugin.convertMessagesToClaudeVertex(messages);
  
  // Should have 2 content items: text + document
  t.is(output.modifiedMessages[0].role, 'user');
  t.is(output.modifiedMessages[0].content.length, 2);
  
  // First should be text
  t.is(output.modifiedMessages[0].content[0].type, 'text');
  t.is(output.modifiedMessages[0].content[0].text, 'Please analyze this document');
  
  // Second should be converted to document block (not text!)
  t.is(output.modifiedMessages[0].content[1].type, 'document');
  t.is(output.modifiedMessages[0].content[1].source.type, 'base64');
  t.is(output.modifiedMessages[0].content[1].source.media_type, 'application/pdf');
});

test('convertMessagesToClaudeVertex document block with PDF URL', async (t) => {
  const plugin = new Claude4VertexPlugin(pathway, model);
  
  // Test with document block containing PDF URL
  const messages = [
      { 
          role: 'user', 
          content: [
              {
                  type: 'document',
                  source: {
                      type: 'url',
                      url: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf'
                  }
              }
          ]
      }
  ];
  
  const output = await plugin.convertMessagesToClaudeVertex(messages);
  
  // Verify the document was converted
  t.is(output.modifiedMessages[0].role, 'user');
  t.is(output.modifiedMessages[0].content[0].type, 'document');
  t.is(output.modifiedMessages[0].content[0].source.type, 'base64');
  t.is(output.modifiedMessages[0].content[0].source.media_type, 'application/pdf');
  
  // Verify base64 data exists
  const base64Data = output.modifiedMessages[0].content[0].source.data;
  const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
  t.true(base64Data.length > 100);
  t.true(base64Regex.test(base64Data));
});

test('convertMessagesToClaudeVertex document block with text file URL', async (t) => {
  const plugin = new Claude4VertexPlugin(pathway, model);
  
  // Test with document block containing text file data (base64)
  const textContent = 'Sample text file content';
  const base64Text = Buffer.from(textContent).toString('base64');
  
  const messages = [
      { 
          role: 'user', 
          content: [
              {
                  type: 'document',
                  source: {
                      type: 'base64',
                      media_type: 'text/plain',
                      data: base64Text
                  }
              }
          ]
      }
  ];
  
  const output = await plugin.convertMessagesToClaudeVertex(messages);
  
  // For text files, should be converted to text content block
  t.is(output.modifiedMessages[0].role, 'user');
  t.is(output.modifiedMessages[0].content[0].type, 'text');
  t.is(output.modifiedMessages[0].content[0].text, textContent);
});

test('convertMessagesToClaudeVertex document block with file_id', async (t) => {
  const plugin = new Claude4VertexPlugin(pathway, model);
  
  // Test with document block containing file_id
  const messages = [
      { 
          role: 'user', 
          content: [
              {
                  type: 'document',
                  source: {
                      type: 'file',
                      file_id: 'file_abc123'
                  }
              }
          ]
      }
  ];
  
  const output = await plugin.convertMessagesToClaudeVertex(messages);
  
  // Should pass through file_id reference
  t.is(output.modifiedMessages[0].role, 'user');
  t.is(output.modifiedMessages[0].content[0].type, 'document');
  t.is(output.modifiedMessages[0].content[0].source.type, 'file');
  t.is(output.modifiedMessages[0].content[0].source.file_id, 'file_abc123');
});

test('convertMessagesToClaudeVertex document block with base64 PDF', async (t) => {
  const plugin = new Claude4VertexPlugin(pathway, model);
  
  // Create a sample base64 PDF string
  const base64Pdf = Buffer.from('Sample PDF content').toString('base64');
  
  const messages = [
      { 
          role: 'user', 
          content: [
              {
                  type: 'document',
                  source: {
                      type: 'base64',
                      media_type: 'application/pdf',
                      data: base64Pdf
                  }
              }
          ]
      }
  ];
  
  const output = await plugin.convertMessagesToClaudeVertex(messages);
  
  // Should pass through as document block
  t.is(output.modifiedMessages[0].role, 'user');
  t.is(output.modifiedMessages[0].content[0].type, 'document');
  t.is(output.modifiedMessages[0].content[0].source.type, 'base64');
  t.is(output.modifiedMessages[0].content[0].source.media_type, 'application/pdf');
  t.is(output.modifiedMessages[0].content[0].source.data, base64Pdf);
});

test('convertMessagesToClaudeVertex mixed content with documents', async (t) => {
  const plugin = new Claude4VertexPlugin(pathway, model);
  
  // Test with mixed content including document and text
  const base64Pdf = Buffer.from('Sample PDF content').toString('base64');
  
  const messages = [
      { 
          role: 'user', 
          content: [
              {
                  type: 'text',
                  text: 'Please analyze this document'
              },
              {
                  type: 'document',
                  source: {
                      type: 'base64',
                      media_type: 'application/pdf',
                      data: base64Pdf
                  }
              }
          ]
      }
  ];
  
  const output = await plugin.convertMessagesToClaudeVertex(messages);
  
  // Should have both text and document blocks
  t.is(output.modifiedMessages[0].role, 'user');
  t.is(output.modifiedMessages[0].content.length, 2);
  t.is(output.modifiedMessages[0].content[0].type, 'text');
  t.is(output.modifiedMessages[0].content[1].type, 'document');
});

test('convertMessagesToClaudeVertex unsupported type', async (t) => {
    const plugin = new Claude4VertexPlugin(pathway, model);
    // Test with unsupported type
    const messages = [{ role: 'user', content: { type: 'unsupported_type' } }];
    const output = await plugin.convertMessagesToClaudeVertex(messages);
    t.deepEqual(output, { system: '', modifiedMessages: [{role: 'user', content: [] }] });
});

test('convertMessagesToClaudeVertex empty messages', async (t) => {
    const plugin = new Claude4VertexPlugin(pathway, model);
    // Test with empty messages
    const messages = [];
    const output = await plugin.convertMessagesToClaudeVertex(messages);
    t.deepEqual(output, { system: '', modifiedMessages: [] });
});

test('convertMessagesToClaudeVertex system message', async (t) => {
    const plugin = new Claude4VertexPlugin(pathway, model);
    // Test with system message
    const messages = [{ role: 'system', content: 'System message' }];
    const output = await plugin.convertMessagesToClaudeVertex(messages);
    t.deepEqual(output, { system: 'System message', modifiedMessages: [] });
});

test('convertMessagesToClaudeVertex system message with user message', async (t) => {
    const plugin = new Claude4VertexPlugin(pathway, model);
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

test('convertMessagesToClaudeVertex with multi-part content array', async (t) => {
  const plugin = new Claude4VertexPlugin(pathway, model);
  
  // Test with multi-part content array including text, image, and document
  const base64Pdf = Buffer.from('Sample PDF content').toString('base64');
  
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
    },
    {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: base64Pdf
      }
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
  // We expect 4 items: 2 text items, 1 image item, and 1 document item
  t.is(output.modifiedMessages[0].content.length, 4);
  
  // Verify the text content items
  t.is(output.modifiedMessages[0].content[0].type, 'text');
  t.is(output.modifiedMessages[0].content[0].text, 'Hello world');
  
  t.is(output.modifiedMessages[0].content[1].type, 'text');
  t.is(output.modifiedMessages[0].content[1].text, 'Hello2 world2');
  
  // Verify the image content item
  t.is(output.modifiedMessages[0].content[2].type, 'image');
  t.is(output.modifiedMessages[0].content[2].source.type, 'base64');
  t.is(output.modifiedMessages[0].content[2].source.media_type, 'image/jpeg');
  
  // Verify the document content item
  t.is(output.modifiedMessages[0].content[3].type, 'document');
  t.is(output.modifiedMessages[0].content[3].source.type, 'base64');
  t.is(output.modifiedMessages[0].content[3].source.media_type, 'application/pdf');
  
  // Check if the base64 data looks reasonable
  const base64Data = output.modifiedMessages[0].content[2].source.data;
  const base64Regex = /^[A-Za-z0-9+/]+={0,2}$/;
  t.true(base64Data.length > 100); // Check if the data is sufficiently long
  t.true(base64Regex.test(base64Data)); // Check if the data matches the base64 regex
});

