import test from 'ava';
import ClaudeAnthropicPlugin from '../../../server/plugins/claudeAnthropicPlugin.js';
import { mockPathwayResolverMessages } from '../../helpers/mocks.js';
import { config } from '../../../config.js';

// Create a mock model config that matches Anthropic direct API format
const anthropicModel = {
    ...mockPathwayResolverMessages.model,
    type: 'CLAUDE-ANTHROPIC',
    params: {
        model: 'claude-sonnet-4-20250514'
    },
    endpoints: [
        {
            name: 'Anthropic Claude Sonnet 4',
            url: 'https://api.anthropic.com/v1/messages',
            headers: {
                'x-api-key': '{{ANTHROPIC_API_KEY}}',
                'Content-Type': 'application/json'
            },
            params: {
                model: 'claude-sonnet-4-20250514'
            },
            requestsPerSecond: 10
        }
    ],
    maxTokenLength: 200000,
    maxReturnTokens: 64000,
    maxImageSize: 31457280,
    supportsStreaming: true
};

const { pathway } = mockPathwayResolverMessages;

test('constructor', (t) => {
    const plugin = new ClaudeAnthropicPlugin(pathway, anthropicModel);
    t.is(plugin.config, config);
    t.is(plugin.pathwayPrompt, mockPathwayResolverMessages.pathway.prompt);
    t.true(plugin.isMultiModal);
});

test('parseResponse - text content response', (t) => {
    const plugin = new ClaudeAnthropicPlugin(pathway, anthropicModel);

    const dataWithTextContent = {
        content: [
            { type: 'text', text: 'Hello from Anthropic!' }
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: 'end_turn'
    };
    const result = plugin.parseResponse(dataWithTextContent);
    t.truthy(result.output_text === 'Hello from Anthropic!');
    t.truthy(result.finishReason === 'stop');
    t.truthy(result.usage);
});

test('parseResponse - tool calls response', (t) => {
    const plugin = new ClaudeAnthropicPlugin(pathway, anthropicModel);

    const dataWithToolCalls = {
        content: [
            { 
                type: 'tool_use', 
                id: 'tool_anthropic_1',
                name: 'get_weather',
                input: { location: 'San Francisco' }
            }
        ],
        usage: { input_tokens: 15, output_tokens: 8 },
        stop_reason: 'tool_use'
    };
    const result = plugin.parseResponse(dataWithToolCalls);
    t.truthy(result.output_text === '');
    t.truthy(result.finishReason === 'tool_calls');
    t.truthy(result.toolCalls);
    t.truthy(result.toolCalls.length === 1);
    t.truthy(result.toolCalls[0].id === 'tool_anthropic_1');
    t.truthy(result.toolCalls[0].function.name === 'get_weather');
    t.truthy(result.toolCalls[0].function.arguments === '{"location":"San Francisco"}');
});

test('getRequestParameters includes model in body', async (t) => {
    const plugin = new ClaudeAnthropicPlugin(pathway, anthropicModel);
    
    const messages = [
        { role: 'user', content: 'Hello' }
    ];
    
    const parameters = { messages };
    const requestParams = await plugin.getRequestParameters('', parameters, {});
    
    // Should have model in request body
    t.is(requestParams.model, 'claude-sonnet-4-20250514');
    
    // Should NOT have anthropic_version in body (it's a Vertex thing)
    t.is(requestParams.anthropic_version, undefined);
});

test('convertMessagesToClaudeVertex preserves message conversion from parent', async (t) => {
    const plugin = new ClaudeAnthropicPlugin(pathway, anthropicModel);
    
    // Test message conversion directly - this tests the inherited behavior
    const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'What is 2+2?' }
    ];
    
    const output = await plugin.convertMessagesToClaudeVertex(messages);
    
    // System message should be extracted
    t.is(output.system, 'You are a helpful assistant.');
    
    // User message should be converted to Claude format
    t.is(output.modifiedMessages.length, 1);
    t.is(output.modifiedMessages[0].role, 'user');
    t.deepEqual(output.modifiedMessages[0].content, [{ type: 'text', text: 'What is 2+2?' }]);
});

test('handles tool_use and tool_result in messages', async (t) => {
    const plugin = new ClaudeAnthropicPlugin(pathway, anthropicModel);
    
    // Test that tool messages are handled correctly via message conversion
    const messages = [
        { role: 'user', content: 'Search for cats' },
        { 
            role: 'assistant', 
            content: [
                { 
                    type: 'tool_use', 
                    id: 'tool_1', 
                    name: 'search', 
                    input: { query: 'cats' } 
                }
            ]
        },
        {
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: 'tool_1',
                    content: 'Found 100 results about cats'
                }
            ]
        }
    ];
    
    const output = await plugin.convertMessagesToClaudeVertex(messages);
    
    // Should have 3 messages with proper roles and content types
    t.is(output.modifiedMessages.length, 3);
    t.is(output.modifiedMessages[0].role, 'user');
    t.is(output.modifiedMessages[1].role, 'assistant');
    t.is(output.modifiedMessages[2].role, 'user');
    
    // Tool use should be preserved
    t.is(output.modifiedMessages[1].content[0].type, 'tool_use');
    t.is(output.modifiedMessages[1].content[0].name, 'search');
    
    // Tool result should be preserved  
    t.is(output.modifiedMessages[2].content[0].type, 'tool_result');
});

test('convertMessagesToClaudeVertex inherits from parent', async (t) => {
    const plugin = new ClaudeAnthropicPlugin(pathway, anthropicModel);
    
    // Test with document block - should work same as Claude4VertexPlugin
    const base64Pdf = Buffer.from('Sample PDF content').toString('base64');
    
    const messages = [
        { 
            role: 'user', 
            content: [
                { type: 'text', text: 'Analyze this' },
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
    t.is(output.modifiedMessages[0].content.length, 2);
    t.is(output.modifiedMessages[0].content[0].type, 'text');
    t.is(output.modifiedMessages[0].content[1].type, 'document');
});

test('SSE conversion inherits from parent', (t) => {
    const plugin = new ClaudeAnthropicPlugin(pathway, anthropicModel);
    
    // Test content_block_delta event conversion
    const claudeEvent = {
        data: JSON.stringify({
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Hello' }
        })
    };
    
    const openAIEvent = plugin.convertClaudeSSEToOpenAI(claudeEvent);
    const parsed = JSON.parse(openAIEvent.data);
    
    t.is(parsed.object, 'chat.completion.chunk');
    t.is(parsed.choices[0].delta.content, 'Hello');
});

test('SSE conversion handles tool call events', (t) => {
    const plugin = new ClaudeAnthropicPlugin(pathway, anthropicModel);
    
    // Test content_block_start for tool_use
    const toolStartEvent = {
        data: JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: {
                type: 'tool_use',
                id: 'call_123',
                name: 'get_weather'
            }
        })
    };
    
    const openAIEvent = plugin.convertClaudeSSEToOpenAI(toolStartEvent);
    const parsed = JSON.parse(openAIEvent.data);
    
    t.is(parsed.object, 'chat.completion.chunk');
    t.truthy(parsed.choices[0].delta.tool_calls);
    t.is(parsed.choices[0].delta.tool_calls[0].function.name, 'get_weather');
});
