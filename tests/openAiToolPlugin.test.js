import test from 'ava';
import OpenAIVisionPlugin from '../server/plugins/openAiVisionPlugin.js';
import { mockPathwayResolverMessages } from './mocks.js';
import { config } from '../config.js';

const { pathway, modelName, model } = mockPathwayResolverMessages;

// Helper function to create a plugin instance
const createPlugin = () => {
    const plugin = new OpenAIVisionPlugin(pathway, {
        name: 'test-model',
        type: 'OPENAI-VISION'
    });
    return plugin;
};

// Test OpenAI tools block conversion
test('OpenAI tools block conversion', async (t) => {
    const plugin = createPlugin();
    const prompt = mockPathwayResolverMessages.pathway.prompt;
    
    const parameters = {
        tools: [
            {
                type: 'function',
                function: {
                    name: 'get_weather',
                    description: 'Get current temperature for a given location.',
                    parameters: {
                        type: 'object',
                        properties: {
                            location: {
                                type: 'string',
                                description: 'City and country e.g. Bogotá, Colombia'
                            }
                        },
                        required: ['location'],
                        additionalProperties: false
                    }
                }
            }
        ]
    };

    const cortexRequest = { tools: parameters.tools };
    const result = await plugin.getRequestParameters('test', parameters, prompt, cortexRequest);
    
    t.deepEqual(result.tools, parameters.tools);
});

// Test tool call response handling
test('Tool call response handling', async (t) => {
    const plugin = createPlugin();
    
    const responseData = {
        choices: [{
            message: {
                role: 'assistant',
                content: 'I will check the weather for you.',
                tool_calls: [{
                    id: 'call_123',
                    type: 'function',
                    function: {
                        name: 'get_weather',
                        arguments: '{"location": "Bogotá, Colombia"}'
                    }
                }]
            }
        }]
    };

    const result = plugin.parseResponse(responseData);
    
    // Verify it's a CortexResponse object
    t.truthy(result);
    t.is(typeof result, 'object');
    t.is(result.constructor.name, 'CortexResponse');
    
    // Verify the content
    t.is(result.output_text, 'I will check the weather for you.');
    t.is(result.finishReason, 'tool_calls');
    
    // Verify tool calls
    t.truthy(result.toolCalls);
    t.is(result.toolCalls.length, 1);
    t.is(result.toolCalls[0].id, 'call_123');
    t.is(result.toolCalls[0].type, 'function');
    t.is(result.toolCalls[0].function.name, 'get_weather');
    t.is(result.toolCalls[0].function.arguments, '{"location": "Bogotá, Colombia"}');
});

// Test tool result message handling
test('Tool result message handling', async (t) => {
    const plugin = createPlugin();
    const prompt = mockPathwayResolverMessages.pathway.prompt;
    
    const messages = [
        {
            role: 'assistant',
            content: 'I will check the weather for you.',
            tool_calls: [{
                id: 'call_123',
                type: 'function',
                function: {
                    name: 'get_weather',
                    arguments: '{"location": "Bogotá, Colombia"}'
                }
            }]
        },
        {
            role: 'tool',
            content: 'The weather in Bogotá is 18°C and sunny.',
            tool_call_id: 'call_123'
        }
    ];

    const result = await plugin.tryParseMessages(messages);
    
    t.deepEqual(result, messages);
});

// Test mixed content with tools and images
test('Mixed content with tools and images', async (t) => {
    const plugin = createPlugin();
    const prompt = mockPathwayResolverMessages.pathway.prompt;
    
    // Mock the validateImageUrl method to always return true
    plugin.validateImageUrl = async () => true;
    
    const messages = [
        {
            role: 'user',
            content: [
                { type: 'text', text: 'What\'s the weather in this image?' },
                { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' } }
            ]
        },
        {
            role: 'assistant',
            content: 'I will analyze the image and check the weather.',
            tool_calls: [{
                id: 'call_123',
                type: 'function',
                function: {
                    name: 'get_weather',
                    arguments: '{"location": "Bogotá, Colombia"}'
                }
            }]
        }
    ];

    const result = await plugin.tryParseMessages(messages);
    
    t.is(result[0].role, 'user');
    t.is(result[0].content[0].type, 'text');
    t.is(result[0].content[1].type, 'image_url');
    t.is(result[1].role, 'assistant');
    t.truthy(result[1].tool_calls);
});

// Test error handling in tool calls
test('Error handling in tool calls', async (t) => {
    const plugin = createPlugin();
    
    const responseData = {
        choices: [{
            message: {
                role: 'assistant',
                content: 'I will check the weather for you.',
                tool_calls: [{
                    id: 'call_123',
                    type: 'function',
                    function: {
                        name: 'get_weather',
                        arguments: 'invalid json'
                    }
                }]
            }
        }]
    };

    const result = plugin.parseResponse(responseData);
    
    // Verify it's a CortexResponse object
    t.truthy(result);
    t.is(typeof result, 'object');
    t.is(result.constructor.name, 'CortexResponse');
    
    // Verify the content
    t.is(result.output_text, 'I will check the weather for you.');
    t.is(result.finishReason, 'tool_calls');
    
    // Verify tool calls
    t.truthy(result.toolCalls);
    t.is(result.toolCalls.length, 1);
    t.is(result.toolCalls[0].id, 'call_123');
    t.is(result.toolCalls[0].type, 'function');
    t.is(result.toolCalls[0].function.name, 'get_weather');
    t.is(result.toolCalls[0].function.arguments, 'invalid json');
});

// Test multiple tool calls in sequence
test('Multiple tool calls in sequence', async (t) => {
    const plugin = createPlugin();
    const prompt = mockPathwayResolverMessages.pathway.prompt;
    
    const messages = [
        {
            role: 'assistant',
            content: 'I will check multiple things for you.',
            tool_calls: [
                {
                    id: 'call_123',
                    type: 'function',
                    function: {
                        name: 'get_weather',
                        arguments: '{"location": "Bogotá, Colombia"}'
                    }
                },
                {
                    id: 'call_124',
                    type: 'function',
                    function: {
                        name: 'get_time',
                        arguments: '{"location": "Bogotá, Colombia"}'
                    }
                }
            ]
        },
        {
            role: 'tool',
            content: 'The weather in Bogotá is 18°C and sunny.',
            tool_call_id: 'call_123'
        },
        {
            role: 'tool',
            content: 'The current time in Bogotá is 14:30.',
            tool_call_id: 'call_124'
        }
    ];

    const result = await plugin.tryParseMessages(messages);
    
    t.is(result.length, 3);
    t.is(result[0].role, 'assistant');
    t.is(result[0].tool_calls.length, 2);
    t.is(result[1].role, 'tool');
    t.is(result[2].role, 'tool');
});

