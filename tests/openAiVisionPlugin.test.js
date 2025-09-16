import test from 'ava';
import OpenAIVisionPlugin from '../server/plugins/openAiVisionPlugin.js';
import { mockPathwayResolverMessages } from './mocks.js';

const { pathway, model } = mockPathwayResolverMessages;

// Test the constructor
test('constructor', (t) => {
    const plugin = new OpenAIVisionPlugin(pathway, model);
    t.truthy(plugin);
    t.true(plugin.isMultiModal);
});

// Test tryParseMessages handles null content gracefully
test('tryParseMessages handles null content in array', async (t) => {
    const plugin = new OpenAIVisionPlugin(pathway, model);
    
    // Mock validateImageUrl to return true for any URL
    plugin.validateImageUrl = async () => true;
    
    const messages = [
        {
            role: 'user',
            content: [
                'Valid text content',
                null, // This should be handled gracefully
                undefined, // This should also be handled gracefully
                '{"type": "text", "text": "JSON text content"}'
            ]
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 1);
    t.is(result[0].role, 'user');
    t.true(Array.isArray(result[0].content));
    
    // Should have filtered out null/undefined and converted others to proper format
    const content = result[0].content;
    t.true(content.length >= 2); // At least the valid text content and JSON text content
    
    // Check that all content items are properly formatted
    content.forEach(item => {
        t.truthy(item);
        t.is(typeof item, 'object');
        t.truthy(item.type);
    });
});

// Test tryParseMessages handles null content for non-array content
test('tryParseMessages handles null content for string content', async (t) => {
    const plugin = new OpenAIVisionPlugin(pathway, model);
    
    const messages = [
        {
            role: 'user',
            content: null // This should be converted to empty string
        },
        {
            role: 'assistant', 
            content: undefined // This should also be converted to empty string
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 2);
    t.is(result[0].content, '');
    t.is(result[1].content, '');
});

// Test tryParseMessages handles empty array content
test('tryParseMessages handles empty array content', async (t) => {
    const plugin = new OpenAIVisionPlugin(pathway, model);
    
    const messages = [
        {
            role: 'user',
            content: [] // Empty array should get default text content
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 1);
    t.is(result[0].role, 'user');
    t.true(Array.isArray(result[0].content));
    t.is(result[0].content.length, 1);
    t.deepEqual(result[0].content[0], { type: 'text', text: '' });
});

// Test tryParseMessages handles array with all null items
test('tryParseMessages handles array with all null items', async (t) => {
    const plugin = new OpenAIVisionPlugin(pathway, model);
    
    const messages = [
        {
            role: 'user',
            content: [null, undefined, null] // All null/undefined should result in default content
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 1);
    t.is(result[0].role, 'user');
    t.true(Array.isArray(result[0].content));
    t.is(result[0].content.length, 1);
    t.deepEqual(result[0].content[0], { type: 'text', text: '' });
});

// Test tryParseMessages preserves tool messages unchanged
test('tryParseMessages preserves tool messages', async (t) => {
    const plugin = new OpenAIVisionPlugin(pathway, model);
    
    const messages = [
        {
            role: 'tool',
            content: 'tool response',
            tool_call_id: 'call_123'
        },
        {
            role: 'assistant',
            content: 'assistant response',
            tool_calls: [{ id: 'call_123', type: 'function', function: { name: 'test', arguments: '{}' } }]
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 2);
    t.deepEqual(result[0], messages[0]); // Tool message should be unchanged
    t.deepEqual(result[1], messages[1]); // Assistant with tool_calls should be unchanged
});