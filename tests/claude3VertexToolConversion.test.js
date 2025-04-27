import test from 'ava';
import Claude3VertexPlugin from '../server/plugins/claude3VertexPlugin.js';
import { mockPathwayResolverMessages } from './mocks.js';
import { config } from '../config.js';

const { pathway, modelName, model } = mockPathwayResolverMessages;

// Helper function to create a plugin instance
const createPlugin = () => new Claude3VertexPlugin(pathway, model);

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
                    },
                    strict: true
                }
            }
        ]
    };

    const cortexRequest = { tools: parameters.tools };
    const result = await plugin.getRequestParameters('test', parameters, prompt, cortexRequest);
    
    t.deepEqual(result.tools, [{
        name: 'get_weather',
        description: 'Get current temperature for a given location.',
        input_schema: {
            type: 'object',
            properties: {
                location: {
                    type: 'string',
                    description: 'City and country e.g. Bogotá, Colombia'
                }
            },
            required: ['location']
        }
    }]);
});

// Test tool call conversion without tools block
test('Tool call conversion without tools block', async (t) => {
    const plugin = createPlugin();
    const prompt = mockPathwayResolverMessages.pathway.prompt;
    
    const messages = [
        {
            role: 'system',
            content: 'You are a helpful assistant'
        },
        {
            role: 'user',
            content: 'What\'s in my memory?'
        },
        {
            role: 'assistant',
            content: [
                {
                    type: 'tool_use',
                    id: 'tool_1',
                    name: 'memory_lookup',
                    input: 'search memory for relevant information'
                }
            ]
        },
        {
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: 'tool_1',
                    content: 'Memory search results here'
                }
            ]
        }
    ];

    // add messages to mockPrompt.messages
    prompt.messages = messages;

    const cortexRequest = {};
    const result = await plugin.getRequestParameters('test', {}, prompt, cortexRequest);
    
    // Check generated tools block
    t.deepEqual(result.tools, [{
        name: 'memory_lookup',
        description: 'Tool for memory_lookup',
        input_schema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Parameter query for memory_lookup'
                }
            },
            required: ['query']
        }
    }]);

    // Check converted messages
    t.is(result.messages[1].role, 'assistant');
    t.deepEqual(result.messages[1].content[0], {
        type: 'tool_use',
        id: 'tool_1',
        name: 'memory_lookup',
        input: { query: 'search memory for relevant information' }
    });

    t.is(result.messages[2].role, 'user');
    t.deepEqual(result.messages[2].content[0], {
        type: 'tool_result',
        tool_use_id: 'tool_1',
        content: 'Memory search results here'
    });
});

// Test multiple tool calls in conversation
test('Multiple tool calls in conversation', async (t) => {
    const plugin = createPlugin();
    const prompt = mockPathwayResolverMessages.pathway.prompt;
    
    const messages = [
        {
            role: 'system',
            content: 'You are a helpful assistant'
        },
        {
            role: 'user',
            content: 'What\'s in my memory and what\'s the weather in San Francisco?'
        },
        {
            role: 'assistant',
            content: [
                {
                    type: 'tool_use',
                    id: 'tool_1',
                    name: 'memory_lookup',
                    input: { query: 'search memory' }
                }
            ]
        },
        {
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: 'tool_1',
                    content: 'Memory results'
                }
            ]
        },
        {
            role: 'assistant',
            content: [
                {
                    type: 'tool_use',
                    id: 'tool_2',
                    name: 'weather_lookup',
                    input: { location: 'San Francisco' }
                }
            ]
        },
        {
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: 'tool_2',
                    content: 'Weather results'
                }
            ]
        }
    ];

    // add messages to mockPrompt.messages
    prompt.messages = messages;

    const cortexRequest = { messages };
    const result = await plugin.getRequestParameters('test', {}, prompt, cortexRequest);
    
    // Check that both tools are in the tools block
    t.truthy(result.tools, 'Tools should be defined');
    t.is(result.tools.length, 2, 'Should have 2 tools');
    t.deepEqual(result.tools.map(t => t.name).sort(), ['memory_lookup', 'weather_lookup']);

    // Check all messages are converted correctly
    t.is(result.messages.length, 5);
    t.deepEqual(result.messages[1].content[0].input, { query: 'search memory' });
    t.deepEqual(result.messages[3].content[0].input, { location: 'San Francisco' });
});

// Test mixed conversation with tools and regular messages
test('Mixed conversation with tools and regular messages', async (t) => {
    const plugin = createPlugin();
    const prompt = mockPathwayResolverMessages.pathway.prompt;
    
    const messages = [
        {
            role: 'system',
            content: 'You are a helpful assistant'
        },
        {
            role: 'user',
            content: 'What\'s in my memory?'
        },
        {
            role: 'assistant',
            content: [
                {
                    type: 'tool_use',
                    id: 'tool_1',
                    name: 'memory_lookup',
                    input: 'search memory'
                }
            ]
        },
        {
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: 'tool_1',
                    content: 'Memory results here'
                }
            ]
        }
    ];

    // add messages to mockPrompt.messages
    prompt.messages = messages;

    const cortexRequest = { messages };
    const result = await plugin.getRequestParameters('test', {}, prompt, cortexRequest);
    
    // Check system message
    t.is(result.system, 'You are a helpful assistant');
    
    // Check regular messages and tool messages are converted correctly
    t.is(result.messages.length, 3);
    t.deepEqual(result.messages[0].content[0], { type: 'text', text: 'What\'s in my memory?' });
    t.deepEqual(result.messages[1].content[0].input, { query: 'search memory' });
    t.deepEqual(result.messages[2].content[0], {
        type: 'tool_result',
        tool_use_id: 'tool_1',
        content: 'Memory results here'
    });
});

// Test edge cases
test('Tool conversion edge cases', async (t) => {
    const plugin = createPlugin();
    const prompt = mockPathwayResolverMessages.pathway.prompt;
    
    const messages = [
        {
            role: 'system',
            content: 'You are a helpful assistant'
        },
        {
            role: 'user',
            content: 'What\'s in my memory?'
        },
        // Empty tool use
        {
            role: 'assistant',
            content: [
                {
                    type: 'tool_use',
                    id: 'tool_1',
                    name: 'empty_tool',
                    input: {}
                }
            ]
        },
        // Null input
        {
            role: 'assistant',
            content: [
                {
                    type: 'tool_use',
                    id: 'tool_2',
                    name: 'null_tool',
                    input: null
                }
            ]
        },
        // Missing tool_use_id
        {
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    content: 'Result without ID'
                }
            ]
        },
        // Empty tool result
        {
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: 'tool_3',
                    content: ''
                }
            ]
        }
    ];

    // add messages to mockPrompt.messages
    prompt.messages = messages;

    const cortexRequest = { messages };
    const result = await plugin.getRequestParameters('test', {}, prompt, cortexRequest);
    
    // Check tools block handles empty/null inputs
    t.truthy(result.tools, 'Tools should be defined');
    t.truthy(result.tools.find(t => t.name === 'empty_tool'), 'Should have empty_tool');
    t.truthy(result.tools.find(t => t.name === 'null_tool'), 'Should have null_tool');
    t.deepEqual(result.tools.find(t => t.name === 'empty_tool').input_schema.properties, {});
    t.deepEqual(result.tools.find(t => t.name === 'null_tool').input_schema.properties, {});

    // Check messages are converted without crashing
    t.is(result.messages.length, 3);
});

// Test combining existing tools block with generated tools
test('Combining existing tools block with generated tools', async (t) => {
    const plugin = createPlugin();
    const prompt = mockPathwayResolverMessages.pathway.prompt;
    
    const parameters = {
        tools: [
            {
                type: 'function',
                function: {
                    name: 'get_weather',
                    description: 'Get weather',
                    parameters: {
                        type: 'object',
                        properties: {
                            location: { type: 'string' }
                        },
                        required: ['location']
                    }
                }
            }
        ]
    };

    const messages = [
        {
            role: 'system',
            content: 'You are a helpful assistant'
        },
        {
            role: 'user',
            content: 'What\'s in my memory?'
        },
        {
            role: 'assistant',
            content: [
                {
                    type: 'tool_use',
                    id: 'tool_1',
                    name: 'memory_lookup',
                    input: 'search memory'
                }
            ]
        },
        {
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: 'tool_1',
                    content: 'Memory results'
                }
            ]
        }
    ];

    // add messages to mockPrompt.messages
    prompt.messages = messages;

    const cortexRequest = { messages };
    const result = await plugin.getRequestParameters('test', parameters, prompt, cortexRequest);
    
    // Check both tools are present
    t.truthy(result.tools, 'Tools should be defined');
    t.is(result.tools.length, 2, 'Should have 2 tools');
    t.deepEqual(result.tools.map(t => t.name).sort(), ['get_weather', 'memory_lookup']);
});

// Test preventing duplicate tool definitions
test('Prevent duplicate tool definitions', async (t) => {
    const plugin = createPlugin();
    const prompt = mockPathwayResolverMessages.pathway.prompt;
    
    const parameters = {
        tools: [
            {
                type: 'function',
                function: {
                    name: 'memory_lookup',
                    description: 'Look up information in memory',
                    parameters: {
                        type: 'object',
                        properties: {
                            query: {
                                type: 'string',
                                description: 'The search query'
                            }
                        },
                        required: ['query']
                    }
                }
            }
        ]
    };

    const messages = [
        {
            role: 'system',
            content: 'You are a helpful assistant'
        },
        {
            role: 'user',
            content: 'What\'s in my memory?'
        },
        {
            role: 'assistant',
            content: [
                {
                    type: 'tool_use',
                    id: 'tool_1',
                    name: 'memory_lookup',
                    input: { query: 'search memory' }
                }
            ]
        }
    ];

    // Set up the mock prompt with messages
    prompt.messages = messages;

    const cortexRequest = { messages };
    const result = await plugin.getRequestParameters('test', parameters, prompt, cortexRequest);
    
    // Check that we only have one memory_lookup tool definition
    t.truthy(result.tools, 'Tools should be defined');
    t.is(result.tools.length, 1, 'Should have exactly 1 tool');
    t.is(result.tools[0].name, 'memory_lookup', 'Tool should be memory_lookup');
    t.is(result.tools[0].description, 'Look up information in memory', 'Should preserve original tool description');
    
    // Verify the tool_use call is still properly converted
    t.truthy(result.messages, 'Messages should be defined');
    t.is(result.messages.length, 1, 'Should have 1 message after conversion');
    
    // Check the converted message
    const message = result.messages[0];
    t.is(message.role, 'assistant', 'Message should be from assistant');
    t.truthy(message.content, 'Message should have content');
    t.is(message.content.length, 1, 'Message should have one content item');
    t.deepEqual(message.content[0], {
        type: 'tool_use',
        id: 'tool_1',
        name: 'memory_lookup',
        input: { query: 'search memory' }
    });
});