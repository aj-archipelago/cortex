// toolCallsParsing.test.js
// Tests for tool_calls parsing from strings to objects in plugins
// and tool message content array to string conversion

import test from 'ava';
import OpenAIVisionPlugin from '../../../server/plugins/openAiVisionPlugin.js';
import GrokVisionPlugin from '../../../server/plugins/grokVisionPlugin.js';
import Gemini15ChatPlugin from '../../../server/plugins/gemini15ChatPlugin.js';

const mockPathway = {
    name: 'test-pathway',
    temperature: 0.7,
    prompt: 'Test prompt',
    toolCallback: () => {}
};

const mockModel = {
    name: 'test-model',
    type: 'OPENAI-VISION',
    maxTokenLength: 4096,
    maxReturnTokens: 256
};

test('OpenAIVisionPlugin - parses tool_calls from string array to object array', async (t) => {
    const plugin = new OpenAIVisionPlugin(mockPathway, mockModel);
    
    const toolCallString = JSON.stringify({
        id: 'call_123',
        type: 'function',
        function: {
            name: 'test_function',
            arguments: '{"param": "value"}'
        }
    });
    
    const messages = [
        {
            role: 'assistant',
            content: null,
            tool_calls: [toolCallString] // String array as would come from GraphQL/REST
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 1);
    t.is(result[0].role, 'assistant');
    t.truthy(result[0].tool_calls);
    t.is(result[0].tool_calls.length, 1);
    t.is(typeof result[0].tool_calls[0], 'object'); // Should be parsed to object
    t.is(result[0].tool_calls[0].id, 'call_123');
    t.is(result[0].tool_calls[0].type, 'function');
    t.is(result[0].tool_calls[0].function.name, 'test_function');
});

test('OpenAIVisionPlugin - handles tool_calls that are already objects', async (t) => {
    const plugin = new OpenAIVisionPlugin(mockPathway, mockModel);
    
    const messages = [
        {
            role: 'assistant',
            content: null,
            tool_calls: [{
                id: 'call_123',
                type: 'function',
                function: {
                    name: 'test_function',
                    arguments: '{"param": "value"}'
                }
            }] // Already objects
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 1);
    t.is(result[0].tool_calls.length, 1);
    t.is(result[0].tool_calls[0].id, 'call_123');
});

test('OpenAIVisionPlugin - converts tool message content array to string', async (t) => {
    const plugin = new OpenAIVisionPlugin(mockPathway, mockModel);
    
    const messages = [
        {
            role: 'tool',
            content: ['Result 1', 'Result 2'], // Array as would come from REST
            tool_call_id: 'call_123'
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 1);
    t.is(result[0].role, 'tool');
    t.is(typeof result[0].content, 'string'); // Should be converted to string
    t.is(result[0].content, 'Result 1\nResult 2');
});

test('OpenAIVisionPlugin - handles tool message with content object array', async (t) => {
    const plugin = new OpenAIVisionPlugin(mockPathway, mockModel);
    
    const messages = [
        {
            role: 'tool',
            content: [
                { type: 'text', text: 'Result 1' },
                { type: 'text', text: 'Result 2' }
            ],
            tool_call_id: 'call_123'
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 1);
    t.is(typeof result[0].content, 'string');
    t.is(result[0].content, 'Result 1\nResult 2');
});

test('GrokVisionPlugin - parses tool_calls from string array to object array', async (t) => {
    const plugin = new GrokVisionPlugin(mockPathway, { ...mockModel, type: 'GROK-VISION' });
    
    const toolCallString = JSON.stringify({
        id: 'call_456',
        type: 'function',
        function: {
            name: 'grok_function',
            arguments: '{"query": "test"}'
        }
    });
    
    const messages = [
        {
            role: 'assistant',
            content: null,
            tool_calls: [toolCallString]
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 1);
    t.is(result[0].tool_calls.length, 1);
    t.is(typeof result[0].tool_calls[0], 'object');
    t.is(result[0].tool_calls[0].id, 'call_456');
});

test('GrokVisionPlugin - converts tool message content array to string', async (t) => {
    const plugin = new GrokVisionPlugin(mockPathway, { ...mockModel, type: 'GROK-VISION' });
    
    const messages = [
        {
            role: 'tool',
            content: ['Grok result 1', 'Grok result 2'],
            tool_call_id: 'call_456'
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 1);
    t.is(typeof result[0].content, 'string');
    t.is(result[0].content, 'Grok result 1\nGrok result 2');
});

test('Gemini15ChatPlugin - converts tool message content array to string', async (t) => {
    const plugin = new Gemini15ChatPlugin(mockPathway, { ...mockModel, type: 'GEMINI-1.5-VISION' });
    
    const messages = [
        {
            role: 'tool',
            content: ['Gemini result 1', 'Gemini result 2'],
            tool_call_id: 'call_789'
        }
    ];
    
    const result = plugin.convertMessagesToGemini(messages);
    
    // Check that the tool message was converted properly
    const toolMessage = result.modifiedMessages.find(msg => msg.role === 'function');
    t.truthy(toolMessage);
    t.is(typeof toolMessage.parts[0].functionResponse.response.content, 'string');
    t.is(toolMessage.parts[0].functionResponse.response.content, 'Gemini result 1\nGemini result 2');
});

test('OpenAIVisionPlugin - handles mixed tool_calls (strings and objects)', async (t) => {
    const plugin = new OpenAIVisionPlugin(mockPathway, mockModel);
    
    const toolCall1String = JSON.stringify({
        id: 'call_1',
        type: 'function',
        function: { name: 'func1', arguments: '{}' }
    });
    
    const toolCall2Object = {
        id: 'call_2',
        type: 'function',
        function: { name: 'func2', arguments: '{}' }
    };
    
    const messages = [
        {
            role: 'assistant',
            content: null,
            tool_calls: [toolCall1String, toolCall2Object] // Mixed
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result[0].tool_calls.length, 2);
    t.is(typeof result[0].tool_calls[0], 'object'); // Parsed from string
    t.is(typeof result[0].tool_calls[1], 'object'); // Already object
    t.is(result[0].tool_calls[0].id, 'call_1');
    t.is(result[0].tool_calls[1].id, 'call_2');
});

test('OpenAIVisionPlugin - converts non-whitelisted JSON objects in content arrays to text', async (t) => {
    const plugin = new OpenAIVisionPlugin(mockPathway, mockModel);
    
    // Create a JSON object that is NOT a whitelisted content type
    const nonWhitelistedObject = {
        customType: 'metadata',
        data: { key: 'value', nested: { info: 'test' } }
    };
    
    const messages = [
        {
            role: 'user',
            content: [
                { type: 'text', text: 'Hello' }, // Valid whitelisted type
                JSON.stringify(nonWhitelistedObject), // JSON string of non-whitelisted object
                nonWhitelistedObject // Direct object (not whitelisted)
            ]
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 1);
    t.is(Array.isArray(result[0].content), true);
    t.is(result[0].content.length, 3);
    
    // First item should be valid text type
    t.is(result[0].content[0].type, 'text');
    t.is(result[0].content[0].text, 'Hello');
    
    // Second item (JSON string of non-whitelisted object) should be converted to text
    t.is(result[0].content[1].type, 'text');
    t.is(result[0].content[1].text, JSON.stringify(nonWhitelistedObject));
    
    // Third item (direct non-whitelisted object) should be converted to text
    t.is(result[0].content[2].type, 'text');
    t.is(result[0].content[2].text, JSON.stringify(nonWhitelistedObject));
});

test('GrokVisionPlugin - converts non-whitelisted JSON objects in content arrays to text', async (t) => {
    const plugin = new GrokVisionPlugin(mockPathway, { ...mockModel, type: 'GROK-VISION' });
    
    // Create a JSON object that is NOT a whitelisted content type
    const nonWhitelistedObject = {
        customField: 'someValue',
        metadata: { version: 1 }
    };
    
    const messages = [
        {
            role: 'user',
            content: [
                { type: 'text', text: 'Test message' }, // Valid whitelisted type
                JSON.stringify(nonWhitelistedObject), // JSON string of non-whitelisted object
                { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' } }, // Valid whitelisted type
                nonWhitelistedObject // Direct object (not whitelisted)
            ]
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 1);
    t.is(Array.isArray(result[0].content), true);
    t.is(result[0].content.length, 4);
    
    // First item should be valid text type
    t.is(result[0].content[0].type, 'text');
    t.is(result[0].content[0].text, 'Test message');
    
    // Second item (JSON string of non-whitelisted object) should be converted to text
    t.is(result[0].content[1].type, 'text');
    t.is(result[0].content[1].text, JSON.stringify(nonWhitelistedObject));
    
    // Third item should be valid image_url type (if URL validates)
    // Note: This might fail validation, but the type should be preserved if valid
    
    // Fourth item (direct non-whitelisted object) should be converted to text
    t.is(result[0].content[3].type, 'text');
    t.is(result[0].content[3].text, JSON.stringify(nonWhitelistedObject));
});

