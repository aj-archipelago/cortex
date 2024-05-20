import test from 'ava';
import Claude3VertexPlugin from '../server/plugins/claude3VertexPlugin.js';
import { mockPathwayResolverMessages } from './mocks.js';
import { config } from '../config.js';

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
    // Make sure image data is in correct format, this will need to be updated based on the image you are testing with
    const expectedImageDataStart = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv";
    t.is(output.system, '');
    t.is(output.modifiedMessages[0].role, 'assistant');
    t.is(output.modifiedMessages[0].content[0].type, 'image');
    t.is(output.modifiedMessages[0].content[0].source.type, 'base64');
    t.is(output.modifiedMessages[0].content[0].source.media_type, 'image/jpeg');
    t.true(output.modifiedMessages[0].content[0].source.data.startsWith(expectedImageDataStart));
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
  const messages = [{ role: 'user', content: { type: 'image_url', image_url: 'http://example.com/image.svg' } }];
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

