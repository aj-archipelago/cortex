// nonWhitelistedContentConversion.test.js
// Tests for conversion of non-whitelisted JSON objects in content arrays
// Specifically tests the REST -> Plugin flow where JSON stringified objects
// that are not in WHITELISTED_CONTENT_TYPES get converted to text objects

import test from 'ava';
import OpenAIVisionPlugin from '../../../server/plugins/openAiVisionPlugin.js';
import GrokVisionPlugin from '../../../server/plugins/grokVisionPlugin.js';

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

// Simulate what REST endpoint does - stringifies non-string items in content arrays
const simulateRestConversion = (messages) => {
    return messages.map(msg => ({
        ...msg,
        content: Array.isArray(msg.content) ? 
            msg.content.map(item => typeof item === 'string' ? item : JSON.stringify(item)) : 
            msg.content
    }));
};

test('REST -> Plugin: JSON stringified non-whitelisted object preserved as text object', async (t) => {
    const plugin = new OpenAIVisionPlugin(mockPathway, mockModel);
    
    // Create a non-whitelisted object (not in WHITELISTED_CONTENT_TYPES)
    const nonWhitelistedObject = {
        customType: 'metadata',
        data: { key: 'value', nested: { info: 'test' } }
    };
    
    // Simulate what comes from REST endpoint - content array with JSON stringified object
    const restMessages = simulateRestConversion([
        {
            role: 'user',
            content: [
                { type: 'text', text: 'Hello' }, // Valid whitelisted type
                JSON.stringify(nonWhitelistedObject) // JSON string of non-whitelisted object
            ]
        }
    ]);
    
    // Process through plugin (simulating what happens after REST -> GraphQL -> Plugin)
    const pluginOutput = await plugin.tryParseMessages(restMessages);
    
    t.is(pluginOutput.length, 1);
    t.is(Array.isArray(pluginOutput[0].content), true);
    t.is(pluginOutput[0].content.length, 2);
    
    // First item should be valid text type
    t.is(pluginOutput[0].content[0].type, 'text');
    t.is(pluginOutput[0].content[0].text, 'Hello');
    
    // Second item (JSON string of non-whitelisted object) should be converted to text object
    // with the original JSON string preserved in the text field
    t.is(pluginOutput[0].content[1].type, 'text');
    t.is(pluginOutput[0].content[1].text, JSON.stringify(nonWhitelistedObject));
    
    // Verify the JSON string is preserved exactly as sent
    const parsedText = JSON.parse(pluginOutput[0].content[1].text);
    t.deepEqual(parsedText, nonWhitelistedObject);
});

test('REST -> Plugin: Direct non-whitelisted object converted to text object', async (t) => {
    const plugin = new OpenAIVisionPlugin(mockPathway, mockModel);
    
    // Create a non-whitelisted object
    const nonWhitelistedObject = {
        customField: 'someValue',
        metadata: { version: 1, tags: ['tag1', 'tag2'] }
    };
    
    // Simulate REST endpoint - if object is sent directly, REST stringifies it
    const restMessages = simulateRestConversion([
        {
            role: 'user',
            content: [
                nonWhitelistedObject // Direct object (REST will stringify it)
            ]
        }
    ]);
    
    // Process through plugin
    const pluginOutput = await plugin.tryParseMessages(restMessages);
    
    t.is(pluginOutput.length, 1);
    t.is(Array.isArray(pluginOutput[0].content), true);
    t.is(pluginOutput[0].content.length, 1);
    
    // Should be converted to text object with JSON stringified content
    t.is(pluginOutput[0].content[0].type, 'text');
    t.is(pluginOutput[0].content[0].text, JSON.stringify(nonWhitelistedObject));
    
    // Verify we can parse it back
    const parsedText = JSON.parse(pluginOutput[0].content[0].text);
    t.deepEqual(parsedText, nonWhitelistedObject);
});

test('REST -> Plugin: Mixed whitelisted and non-whitelisted objects in content array', async (t) => {
    const plugin = new OpenAIVisionPlugin(mockPathway, mockModel);
    
    const nonWhitelistedObject = {
        customType: 'analytics',
        metrics: { views: 100, clicks: 50 }
    };
    
    // Simulate REST endpoint with mixed content
    const restMessages = simulateRestConversion([
        {
            role: 'user',
            content: [
                { type: 'text', text: 'First message' }, // Valid whitelisted
                JSON.stringify(nonWhitelistedObject), // JSON string of non-whitelisted
                { type: 'text', text: 'Second message' }, // Valid whitelisted
                { type: 'image_url', image_url: { url: 'https://example.com/img.jpg' } }, // Valid whitelisted
                nonWhitelistedObject // Direct object (will be stringified by REST)
            ]
        }
    ]);
    
    const pluginOutput = await plugin.tryParseMessages(restMessages);
    
    t.is(pluginOutput.length, 1);
    t.is(pluginOutput[0].content.length, 5);
    
    // First item - valid text
    t.is(pluginOutput[0].content[0].type, 'text');
    t.is(pluginOutput[0].content[0].text, 'First message');
    
    // Second item - JSON string of non-whitelisted -> text object
    t.is(pluginOutput[0].content[1].type, 'text');
    t.is(pluginOutput[0].content[1].text, JSON.stringify(nonWhitelistedObject));
    
    // Third item - valid text
    t.is(pluginOutput[0].content[2].type, 'text');
    t.is(pluginOutput[0].content[2].text, 'Second message');
    
    // Fourth item - image_url (may fail validation and be converted to text)
    // If validation fails, it becomes text; if it passes, it stays image_url
    t.true(['image_url', 'text'].includes(pluginOutput[0].content[3].type));
    
    // Fifth item - direct object stringified by REST -> text object
    t.is(pluginOutput[0].content[4].type, 'text');
    t.is(pluginOutput[0].content[4].text, JSON.stringify(nonWhitelistedObject));
});

test('GrokVisionPlugin: JSON stringified non-whitelisted object preserved as text object', async (t) => {
    const plugin = new GrokVisionPlugin(mockPathway, { ...mockModel, type: 'GROK-VISION' });
    
    const nonWhitelistedObject = {
        customType: 'grok_metadata',
        data: { x: 1, y: 2 }
    };
    
    const restMessages = simulateRestConversion([
        {
            role: 'user',
            content: [
                { type: 'text', text: 'Grok test' },
                JSON.stringify(nonWhitelistedObject)
            ]
        }
    ]);
    
    const pluginOutput = await plugin.tryParseMessages(restMessages);
    
    t.is(pluginOutput.length, 1);
    t.is(pluginOutput[0].content.length, 2);
    
    // JSON stringified non-whitelisted object should be converted to text object
    t.is(pluginOutput[0].content[1].type, 'text');
    t.is(pluginOutput[0].content[1].text, JSON.stringify(nonWhitelistedObject));
    
    // Verify JSON string is preserved
    const parsedText = JSON.parse(pluginOutput[0].content[1].text);
    t.deepEqual(parsedText, nonWhitelistedObject);
});

