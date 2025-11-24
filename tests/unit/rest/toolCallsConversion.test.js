// toolCallsConversion.test.js
// Tests for REST endpoint tool_calls conversion (stringify objects, preserve strings)

import test from 'ava';
import { getMessageTypeDefs } from '../../../server/typeDef.js';

// Simulate the convertType function from server/rest.js
const convertType = (value, type) => {
    if (type === 'Boolean') {
        return Boolean(value);
    } else if (type === 'Int') {
        return parseInt(value, 10);
    } else if (type === 'Float') {
        return parseFloat(value);
    } else if (type === '[MultiMessage]' && Array.isArray(value)) {
        return value.map(msg => ({
            ...msg,
            content: Array.isArray(msg.content) ? 
                msg.content.map(item => typeof item === 'string' ? item : JSON.stringify(item)) : 
                msg.content,
            tool_calls: Array.isArray(msg.tool_calls) ? 
                msg.tool_calls.map(tc => typeof tc === 'string' ? tc : JSON.stringify(tc)) : 
                msg.tool_calls
        }));
    } else if (type === '[String]' && Array.isArray(value)) {
        return value;
    } else {
        return value;
    }
};

test('REST convertType - stringifies tool_calls objects', (t) => {
    const toolCallObject = {
        id: 'call_123',
        type: 'function',
        function: {
            name: 'test_function',
            arguments: '{"param": "value"}'
        }
    };
    
    const messages = [
        {
            role: 'assistant',
            content: null,
            tool_calls: [toolCallObject] // Object format
        }
    ];
    
    const result = convertType(messages, '[MultiMessage]');
    
    t.is(result.length, 1);
    t.is(result[0].role, 'assistant');
    t.truthy(result[0].tool_calls);
    t.is(result[0].tool_calls.length, 1);
    t.is(typeof result[0].tool_calls[0], 'string'); // Should be stringified
    t.is(result[0].tool_calls[0], JSON.stringify(toolCallObject));
});

test('REST convertType - preserves tool_calls strings', (t) => {
    const toolCallString = JSON.stringify({
        id: 'call_456',
        type: 'function',
        function: {
            name: 'another_function',
            arguments: '{"key": "value"}'
        }
    });
    
    const messages = [
        {
            role: 'assistant',
            content: null,
            tool_calls: [toolCallString] // Already string format
        }
    ];
    
    const result = convertType(messages, '[MultiMessage]');
    
    t.is(result.length, 1);
    t.is(result[0].tool_calls.length, 1);
    t.is(typeof result[0].tool_calls[0], 'string'); // Should remain string
    t.is(result[0].tool_calls[0], toolCallString);
});

test('REST convertType - handles mixed tool_calls (objects and strings)', (t) => {
    const toolCall1Object = {
        id: 'call_1',
        type: 'function',
        function: { name: 'func1', arguments: '{}' }
    };
    
    const toolCall2String = JSON.stringify({
        id: 'call_2',
        type: 'function',
        function: { name: 'func2', arguments: '{}' }
    });
    
    const messages = [
        {
            role: 'assistant',
            content: null,
            tool_calls: [toolCall1Object, toolCall2String] // Mixed
        }
    ];
    
    const result = convertType(messages, '[MultiMessage]');
    
    t.is(result[0].tool_calls.length, 2);
    t.is(typeof result[0].tool_calls[0], 'string'); // Object should be stringified
    t.is(typeof result[0].tool_calls[1], 'string'); // String should remain string
    t.is(result[0].tool_calls[0], JSON.stringify(toolCall1Object));
    t.is(result[0].tool_calls[1], toolCall2String);
});

test('REST convertType - handles messages without tool_calls', (t) => {
    const messages = [
        {
            role: 'user',
            content: 'Hello'
        }
    ];
    
    const result = convertType(messages, '[MultiMessage]');
    
    t.is(result.length, 1);
    t.is(result[0].role, 'user');
    t.falsy(result[0].tool_calls);
});

test('GraphQL schema - MultiMessage includes tool_calls field', (t) => {
    const typeDefs = getMessageTypeDefs();
    
    // Check that tool_calls is in the MultiMessage type definition
    t.true(typeDefs.includes('tool_calls'));
    t.true(typeDefs.includes('MultiMessage'));
    // Should be defined as [String] array
    t.true(typeDefs.includes('tool_calls: [String]') || typeDefs.includes('tool_calls:[String]'));
});

test('REST convertType - handles tool_calls with null/undefined', (t) => {
    const messages = [
        {
            role: 'assistant',
            content: 'Some content',
            tool_calls: null
        },
        {
            role: 'user',
            content: 'Hello',
            tool_calls: undefined
        }
    ];
    
    const result = convertType(messages, '[MultiMessage]');
    
    t.is(result.length, 2);
    t.falsy(result[0].tool_calls);
    t.falsy(result[1].tool_calls);
});

