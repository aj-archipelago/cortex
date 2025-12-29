import test from 'ava';
import OpenAIChatPlugin from '../../../../server/plugins/openAiChatPlugin.js';
import { config } from '../../../../config.js';

/**
 * Test OpenAI token counting using tiktoken
 */
test('OpenAI countTokensBeforeRequest - basic messages', async t => {
    // Create a mock plugin instance
    const mockPathway = {};
    const mockModel = {
        name: 'gpt-4o',
        type: 'OPENAI-CHAT'
    };
    
    const plugin = new OpenAIChatPlugin(mockPathway, mockModel);
    plugin.config = config;
    
    const messages = [
        {
            role: 'user',
            content: 'Hello, how are you?'
        },
        {
            role: 'assistant',
            content: 'I am doing well, thank you!'
        }
    ];
    
    const tokenCount = await plugin.countTokensBeforeRequest(messages);
    
    t.truthy(tokenCount, 'Should return a token count');
    t.true(typeof tokenCount === 'number', 'Token count should be a number');
    t.true(tokenCount > 0, 'Token count should be positive');
    
    // Basic messages should be around 20-30 tokens
    t.true(tokenCount >= 15, 'Should have at least 15 tokens');
    t.true(tokenCount <= 50, 'Should not exceed 50 tokens for simple messages');
    
    console.log(`Token count for basic messages: ${tokenCount}`);
});

test('OpenAI countTokensBeforeRequest - with tool calls', async t => {
    const mockPathway = {};
    const mockModel = {
        name: 'gpt-4o',
        type: 'OPENAI-CHAT'
    };
    
    const plugin = new OpenAIChatPlugin(mockPathway, mockModel);
    plugin.config = config;
    
    const messages = [
        {
            role: 'user',
            content: 'What is the weather in New York?'
        },
        {
            role: 'assistant',
            content: null,
            tool_calls: [
                {
                    id: 'call_123',
                    type: 'function',
                    function: {
                        name: 'get_weather',
                        arguments: '{"location": "New York"}'
                    }
                }
            ]
        },
        {
            role: 'tool',
            tool_call_id: 'call_123',
            name: 'get_weather',
            content: '{"temperature": 72, "condition": "sunny"}'
        }
    ];
    
    const tokenCount = await plugin.countTokensBeforeRequest(messages);
    
    t.truthy(tokenCount, 'Should return a token count');
    t.true(tokenCount > 0, 'Token count should be positive');
    
    // Tool calls add overhead
    t.true(tokenCount >= 30, 'Should have at least 30 tokens with tool calls');
    
    console.log(`Token count with tool calls: ${tokenCount}`);
});

test('OpenAI countTokensBeforeRequest - multimodal content', async t => {
    const mockPathway = {};
    const mockModel = {
        name: 'gpt-4o',
        type: 'OPENAI-CHAT'
    };
    
    const plugin = new OpenAIChatPlugin(mockPathway, mockModel);
    plugin.config = config;
    
    const messages = [
        {
            role: 'user',
            content: [
                {
                    type: 'text',
                    text: 'What is in this image?'
                },
                {
                    type: 'image_url',
                    image_url: {
                        url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
                    }
                }
            ]
        }
    ];
    
    const tokenCount = await plugin.countTokensBeforeRequest(messages);
    
    t.truthy(tokenCount, 'Should return a token count');
    t.true(tokenCount > 0, 'Token count should be positive');
    
    // Images add significant tokens
    t.true(tokenCount >= 150, 'Should have at least 150 tokens with image');
    
    console.log(`Token count with image: ${tokenCount}`);
});

test('OpenAI countTokensBeforeRequest - empty messages', async t => {
    const mockPathway = {};
    const mockModel = {
        name: 'gpt-4o',
        type: 'OPENAI-CHAT'
    };
    
    const plugin = new OpenAIChatPlugin(mockPathway, mockModel);
    plugin.config = config;
    
    const tokenCount = await plugin.countTokensBeforeRequest([]);
    
    t.is(tokenCount, 0, 'Empty messages should return 0 tokens');
});

test('OpenAI countTokensBeforeRequest - different models', async t => {
    const models = ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo', 'o1-preview'];
    
    const messages = [
        {
            role: 'user',
            content: 'Test message'
        }
    ];
    
    for (const modelName of models) {
        const mockPathway = {};
        const mockModel = {
            name: modelName,
            type: 'OPENAI-CHAT'
        };
        
        const plugin = new OpenAIChatPlugin(mockPathway, mockModel);
        plugin.config = config;
        
        const tokenCount = await plugin.countTokensBeforeRequest(messages);
        
        t.truthy(tokenCount, `Should return token count for ${modelName}`);
        t.true(tokenCount > 0, `Token count should be positive for ${modelName}`);
        
        console.log(`${modelName}: ${tokenCount} tokens`);
    }
});

