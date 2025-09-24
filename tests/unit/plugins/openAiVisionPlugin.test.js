import test from 'ava';
import OpenAIVisionPlugin from '../../../server/plugins/openAiVisionPlugin.js';
import { mockPathwayResolverMessages } from '../../helpers/mocks.js';
import { config } from '../../../config.js';

const { pathway, modelName, model } = mockPathwayResolverMessages;

// Test the constructor
test('constructor', (t) => {
    const plugin = new OpenAIVisionPlugin(pathway, model);
    t.is(plugin.config, config);
    t.is(plugin.pathwayPrompt, mockPathwayResolverMessages.pathway.prompt);
    t.is(plugin.isMultiModal, true);
    t.deepEqual(plugin.toolCallsBuffer, []);
    t.is(plugin.contentBuffer, '');
});

// Test null content handling in tryParseMessages
test('tryParseMessages handles null content', async (t) => {
    const plugin = new OpenAIVisionPlugin(pathway, model);
    const messages = [
        { role: 'user', content: null },
        { role: 'assistant', content: 'Hello' },
        { role: 'user', content: undefined },
        { role: 'system', content: 'System message' }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result[0].content, '');  // null converted to empty string
    t.is(result[1].content, 'Hello');  // unchanged
    t.is(result[2].content, undefined);  // undefined remains undefined (handled later)
    t.is(result[3].content, 'System message');  // unchanged
});

// Test comprehensive null content validation in getRequestParameters
test('getRequestParameters ensures no null content in messages', async (t) => {
    const plugin = new OpenAIVisionPlugin(pathway, model);
    const text = 'Test text';
    const parameters = {};
    const prompt = {
        messages: [
            { role: 'user', content: null },
            { role: 'assistant', content: undefined },
            { role: 'user', content: 'Valid content' },
            { role: 'tool', content: null }
        ]
    };
    
    const result = await plugin.getRequestParameters(text, parameters, prompt);
    
    // All null/undefined content should be converted to empty strings
    result.messages.forEach(message => {
        t.not(message.content, null, 'Message content should not be null');
        t.not(message.content, undefined, 'Message content should not be undefined');
        if (message.content === '') {
            t.pass('Empty string is acceptable');
        } else {
            t.is(typeof message.content, 'string', 'Message content should be a string');
        }
    });
});

// Test tool calls handling with null content
test('tryParseMessages handles tool calls with null content', async (t) => {
    const plugin = new OpenAIVisionPlugin(pathway, model);
    const messages = [
        { 
            role: 'assistant', 
            content: null,
            tool_calls: [
                {
                    id: 'call_123',
                    type: 'function',
                    function: { name: 'test_function', arguments: '{}' }
                }
            ]
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    t.is(result[0].content, '');  // null content converted to empty string
    t.truthy(result[0].tool_calls);  // tool_calls preserved
    t.is(result[0].tool_calls[0].id, 'call_123');
});

// Test array content handling with null elements
test('tryParseMessages handles array content with null elements', async (t) => {
    const plugin = new OpenAIVisionPlugin(pathway, model);
    const messages = [
        { 
            role: 'user', 
            content: [
                { type: 'text', text: 'Hello' },
                null,  // This might cause issues
                { type: 'text', text: 'World' }
            ]
        }
    ];
    
    const result = await plugin.tryParseMessages(messages);
    
    // Should handle array content gracefully
    t.truthy(Array.isArray(result[0].content));
    // The specific handling depends on implementation but should not crash
});

// Test mixed message types with null content
test('getRequestParameters handles mixed message types with null content', async (t) => {
    const plugin = new OpenAIVisionPlugin(pathway, model);
    const text = 'Test input';
    const parameters = {};
    const prompt = {
        messages: [
            { role: 'system', content: 'System prompt' },
            { role: 'user', content: null },
            { 
                role: 'assistant', 
                content: null,
                tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'test' } }]
            },
            { role: 'tool', content: null, tool_call_id: 'call_1' },
            { role: 'user', content: 'Final message' }
        ]
    };
    
    const result = await plugin.getRequestParameters(text, parameters, prompt);
    
    // Verify all messages have been processed and no content is null
    t.is(result.messages.length, 5);
    result.messages.forEach((message, index) => {
        t.not(message.content, null, `Message ${index} content should not be null`);
        t.not(message.content, undefined, `Message ${index} content should not be undefined`);
    });
});

// Test that valid content is preserved
test('getRequestParameters preserves valid content', async (t) => {
    const plugin = new OpenAIVisionPlugin(pathway, model);
    const text = 'Test text';
    const parameters = {};
    const prompt = {
        messages: [
            { role: 'user', content: 'Valid user message' },
            { role: 'assistant', content: 'Valid assistant response' },
            { role: 'system', content: 'Valid system message' }
        ]
    };
    
    const result = await plugin.getRequestParameters(text, parameters, prompt);
    
    t.is(result.messages[0].content, 'Valid user message');
    t.is(result.messages[1].content, 'Valid assistant response');
    t.is(result.messages[2].content, 'Valid system message');
});