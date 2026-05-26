// grokResponsesPlugin.test.js
// Unit tests for Grok Responses API plugin (xAI Responses API)

import test from 'ava';

// Import the plugin class
import GrokResponsesPlugin, { safeJsonParse, convertMessagesToResponsesInput } from '../../../server/plugins/grokResponsesPlugin.js';
import { Prompt } from '../../../server/prompt.js';

// Create a minimal mock pathway and model for testing
const createMockPlugin = () => {
    const mockPathway = {
        name: 'test_pathway',
        model: {
            name: 'grok-4'
        }
    };
    const mockModel = {
        name: 'grok-4',
        url: 'https://api.x.ai/v1/responses'
    };
    return new GrokResponsesPlugin(mockPathway, mockModel);
};

// ============================================================================
// Helper Function Tests
// ============================================================================

test('convertMessagesToResponsesInput leaves string content alone', t => {
    const messages = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
    ];
    t.deepEqual(convertMessagesToResponsesInput(messages), messages);
});

test('convertMessagesToResponsesInput rewrites user text parts to input_text', t => {
    const out = convertMessagesToResponsesInput([
        { role: 'user', content: [{ type: 'text', text: 'Hi' }, { type: 'text', text: 'there' }] },
    ]);
    t.deepEqual(out, [
        { role: 'user', content: [{ type: 'input_text', text: 'Hi' }, { type: 'input_text', text: 'there' }] },
    ]);
});

test('convertMessagesToResponsesInput rewrites assistant text parts to output_text', t => {
    const out = convertMessagesToResponsesInput([
        { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
    ]);
    t.deepEqual(out, [
        { role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] },
    ]);
});

test('convertMessagesToResponsesInput rewrites image_url parts to flat input_image', t => {
    const out = convertMessagesToResponsesInput([
        {
            role: 'user',
            content: [
                { type: 'text', text: 'What is this?' },
                { type: 'image_url', image_url: { url: 'https://example.com/cat.jpg', detail: 'high' } },
            ],
        },
    ]);
    t.deepEqual(out, [
        {
            role: 'user',
            content: [
                { type: 'input_text', text: 'What is this?' },
                { type: 'input_image', image_url: 'https://example.com/cat.jpg', detail: 'high' },
            ],
        },
    ]);
});

test('convertMessagesToResponsesInput accepts already-flat image_url string', t => {
    const out = convertMessagesToResponsesInput([
        { role: 'user', content: [{ type: 'image_url', image_url: 'https://example.com/cat.jpg' }] },
    ]);
    t.deepEqual(out, [
        { role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/cat.jpg' }] },
    ]);
});

test('convertMessagesToResponsesInput wraps bare strings in an array', t => {
    const out = convertMessagesToResponsesInput([
        { role: 'user', content: ['raw'] },
        { role: 'assistant', content: ['reply'] },
    ]);
    t.deepEqual(out, [
        { role: 'user', content: [{ type: 'input_text', text: 'raw' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'reply' }] },
    ]);
});

test('convertMessagesToResponsesInput passes through unknown part types', t => {
    const out = convertMessagesToResponsesInput([
        { role: 'user', content: [{ type: 'custom_thing', payload: { x: 1 } }] },
    ]);
    t.deepEqual(out, [
        { role: 'user', content: [{ type: 'custom_thing', payload: { x: 1 } }] },
    ]);
});

test('safeJsonParse should parse valid JSON', t => {
    const result = safeJsonParse('{"key": "value"}');
    t.deepEqual(result, { key: 'value' });
});

test('safeJsonParse should return original string for invalid JSON', t => {
    const result = safeJsonParse('not valid json');
    t.is(result, 'not valid json');
});

test('safeJsonParse should return original for primitive JSON values', t => {
    // safeJsonParse only returns objects, primitives are returned as-is (original string)
    t.is(safeJsonParse('"string"'), '"string"');
    t.is(safeJsonParse('123'), '123');
});

// ============================================================================
// Tools Validation and Transformation Tests
// ============================================================================

test('validateAndTransformTools should handle web_search tool', t => {
    const plugin = createMockPlugin();
    const tools = {
        web_search: true
    };

    const result = plugin.validateAndTransformTools(tools);

    t.true(Array.isArray(result));
    t.is(result.length, 1);
    t.is(result[0].type, 'web_search');
});

test('validateAndTransformTools should handle x_search tool', t => {
    const plugin = createMockPlugin();
    const tools = {
        x_search: true
    };

    const result = plugin.validateAndTransformTools(tools);

    t.true(Array.isArray(result));
    t.is(result.length, 1);
    t.is(result[0].type, 'x_search');
});

test('validateAndTransformTools should handle web_search with domain filters', t => {
    const plugin = createMockPlugin();
    const tools = {
        web_search: {
            allowed_domain: ['example.com', 'test.org'],
            excluded_domain: ['spam.com']
        }
    };

    const result = plugin.validateAndTransformTools(tools);

    t.true(Array.isArray(result));
    t.is(result.length, 1);
    t.is(result[0].type, 'web_search');
    t.deepEqual(result[0].filters.allowed_domains, ['example.com', 'test.org']);
    t.deepEqual(result[0].filters.excluded_domains, ['spam.com']);
});

test('validateAndTransformTools should handle x_search with handles', t => {
    const plugin = createMockPlugin();
    const tools = {
        x_search: {
            allowed_x_handles: ['OpenAI', 'xai'],
            excluded_x_handles: ['spam_bot']
        }
    };

    const result = plugin.validateAndTransformTools(tools);

    t.true(Array.isArray(result));
    t.is(result.length, 1);
    t.is(result[0].type, 'x_search');
    t.deepEqual(result[0].allowed_x_handles, ['OpenAI', 'xai']);
    t.deepEqual(result[0].excluded_x_handles, ['spam_bot']);
});

test('validateAndTransformTools should handle x_search with date range', t => {
    const plugin = createMockPlugin();
    const tools = {
        x_search: {
            from_date: '2025-01-01',
            to_date: '2025-01-31'
        }
    };

    const result = plugin.validateAndTransformTools(tools);

    t.true(Array.isArray(result));
    t.is(result.length, 1);
    t.is(result[0].type, 'x_search');
    t.is(result[0].from_date, '2025-01-01');
    t.is(result[0].to_date, '2025-01-31');
});

test('validateAndTransformTools should handle both web_search and x_search', t => {
    const plugin = createMockPlugin();
    const tools = {
        web_search: true,
        x_search: true
    };

    const result = plugin.validateAndTransformTools(tools);

    t.true(Array.isArray(result));
    t.is(result.length, 2);

    const types = result.map(tool => tool.type);
    t.true(types.includes('web_search'));
    t.true(types.includes('x_search'));
});

test('validateAndTransformTools should pass through array format', t => {
    const plugin = createMockPlugin();
    const tools = [
        { type: 'web_search' },
        { type: 'x_search', allowed_x_handles: ['test'] }
    ];

    const result = plugin.validateAndTransformTools(tools);

    t.deepEqual(result, tools);
});

// ============================================================================
// Legacy search_parameters Conversion Tests
// ============================================================================

test('convertSearchParametersToTools should convert web source', t => {
    const plugin = createMockPlugin();
    const searchParams = {
        sources: [{ type: 'web' }]
    };

    const result = plugin.convertSearchParametersToTools(searchParams);

    t.true(Array.isArray(result));
    t.is(result.length, 1);
    t.is(result[0].type, 'web_search');
});

test('convertSearchParametersToTools should convert x source', t => {
    const plugin = createMockPlugin();
    const searchParams = {
        sources: [{ type: 'x' }]
    };

    const result = plugin.convertSearchParametersToTools(searchParams);

    t.true(Array.isArray(result));
    t.is(result.length, 1);
    t.is(result[0].type, 'x_search');
});

test('convertSearchParametersToTools should convert both sources', t => {
    const plugin = createMockPlugin();
    const searchParams = {
        sources: [{ type: 'web' }, { type: 'x' }]
    };

    const result = plugin.convertSearchParametersToTools(searchParams);

    t.true(Array.isArray(result));
    t.is(result.length, 2);

    const types = result.map(tool => tool.type);
    t.true(types.includes('web_search'));
    t.true(types.includes('x_search'));
});

test('convertSearchParametersToTools should add default tools when no sources specified', t => {
    const plugin = createMockPlugin();
    const searchParams = {
        mode: 'auto'
    };

    const result = plugin.convertSearchParametersToTools(searchParams);

    t.true(Array.isArray(result));
    t.is(result.length, 2);

    const types = result.map(tool => tool.type);
    t.true(types.includes('web_search'));
    t.true(types.includes('x_search'));
});

test('convertSearchParametersToTools should return null for mode: off', t => {
    const plugin = createMockPlugin();
    const searchParams = {
        mode: 'off',
        sources: []
    };

    const result = plugin.convertSearchParametersToTools(searchParams);

    t.is(result, null);
});

test('convertSearchParametersToTools should handle x handles', t => {
    const plugin = createMockPlugin();
    const searchParams = {
        sources: [{
            type: 'x',
            included_x_handles: ['OpenAI', 'xai'],
            excluded_x_handles: ['spam']
        }]
    };

    const result = plugin.convertSearchParametersToTools(searchParams);

    t.true(Array.isArray(result));
    t.is(result.length, 1);
    t.is(result[0].type, 'x_search');
    t.deepEqual(result[0].allowed_x_handles, ['OpenAI', 'xai']);
    t.deepEqual(result[0].excluded_x_handles, ['spam']);
});

// ============================================================================
// Response Parsing Tests
// ============================================================================

test('parseResponsesApiFormat should extract output_text', t => {
    const plugin = createMockPlugin();
    const data = {
        id: 'resp_123',
        output_text: 'Hello from Grok!',
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 5 }
    };

    const result = plugin.parseResponsesApiFormat(data);

    t.is(result.output_text, 'Hello from Grok!');
    t.is(result.finishReason, 'completed');
});

test('parseResponsesApiFormat should handle citations array', t => {
    const plugin = createMockPlugin();
    const data = {
        id: 'resp_123',
        output_text: 'Here is some info [[1]](https://example.com)',
        citations: ['https://example.com', 'https://test.org'],
        status: 'completed'
    };

    const result = plugin.parseResponsesApiFormat(data);

    t.truthy(result.citations);
    t.is(result.citations.length, 2);
    t.is(result.citations[0].url, 'https://example.com');
    t.is(result.citations[1].url, 'https://test.org');
});

test('parseResponsesApiFormat should extract inline citations from text', t => {
    const plugin = createMockPlugin();
    const data = {
        id: 'resp_123',
        output_text: 'According to [[1]](https://example.com/article) and [[2]](https://test.org/post), this is true.',
        status: 'completed'
    };

    const result = plugin.parseResponsesApiFormat(data);

    t.truthy(result.citations);
    t.is(result.citations.length, 2);
    t.is(result.citations[0].url, 'https://example.com/article');
    t.is(result.citations[1].url, 'https://test.org/post');
});

test('parseResponsesApiFormat should extract rich metadata from X citations', t => {
    const plugin = createMockPlugin();
    const data = {
        id: 'resp_123',
        output_text: '@elonmusk posted "This is exciting news!" [[1]](https://x.com/elonmusk/status/123456789)',
        status: 'completed'
    };

    const result = plugin.parseResponsesApiFormat(data);

    t.truthy(result.citations);
    t.is(result.citations.length, 1);
    t.is(result.citations[0].url, 'https://x.com/elonmusk/status/123456789');
    t.is(result.citations[0].author, 'elonmusk');
});

test('parseResponsesApiFormat should handle output array format', t => {
    const plugin = createMockPlugin();
    const data = {
        id: 'resp_123',
        output: [
            {
                type: 'message',
                content: [
                    { type: 'output_text', text: 'Part 1' },
                    { type: 'output_text', text: ' Part 2' }
                ]
            }
        ],
        status: 'completed'
    };

    const result = plugin.parseResponsesApiFormat(data);

    t.is(result.output_text, 'Part 1 Part 2');
});

// ============================================================================
// Edge Cases
// ============================================================================

test('parseResponse should handle empty data', t => {
    const plugin = createMockPlugin();
    const result = plugin.parseResponse(null);
    t.is(result, '');
});

test('parseResponse should handle legacy OpenAI format', t => {
    const plugin = createMockPlugin();
    const data = {
        choices: [
            {
                message: {
                    content: 'Hello!',
                    role: 'assistant'
                },
                finish_reason: 'stop'
            }
        ]
    };

    const result = plugin.parseResponse(data);

    t.is(result.output_text, 'Hello!');
    t.is(result.finishReason, 'stop');
});

test('processStreamEvent should ignore OpenAI response lifecycle events', t => {
    const plugin = createMockPlugin();
    const requestProgress = {};
    const eventData = {
        type: 'response.completed',
        response: { id: 'resp_123' }
    };

    const result = plugin.processStreamEvent({ data: JSON.stringify(eventData) }, requestProgress);

    t.is(result.progress, undefined);
    t.is(result.data, undefined);
});

test('validateAndTransformTools should limit handles to 10', t => {
    const plugin = createMockPlugin();
    const manyHandles = Array.from({ length: 15 }, (_, i) => `handle${i}`);
    const tools = {
        x_search: {
            allowed_x_handles: manyHandles
        }
    };

    const result = plugin.validateAndTransformTools(tools);

    t.is(result[0].allowed_x_handles.length, 10);
});

test('getRequestParameters converts max_tokens to max_output_tokens for Responses API', async t => {
    const plugin = createMockPlugin();

    const params = await plugin.getRequestParameters('hello', {}, new Prompt({
        messages: [{ role: 'user', content: '{{{text}}}' }]
    }));

    t.true(typeof params.max_output_tokens === 'number' && params.max_output_tokens > 0);
    t.false(Object.prototype.hasOwnProperty.call(params, 'max_tokens'));
});

test('getRequestParameters prefers caller-supplied max_output_tokens over derived max_tokens', async t => {
    const plugin = createMockPlugin();

    const params = await plugin.getRequestParameters('hello', { max_output_tokens: 1234 }, new Prompt({
        messages: [{ role: 'user', content: '{{{text}}}' }]
    }));

    t.is(params.max_output_tokens, 1234);
    t.false(Object.prototype.hasOwnProperty.call(params, 'max_tokens'));
});

test('validateAndTransformTools should limit domains to 5', t => {
    const plugin = createMockPlugin();
    const manyDomains = Array.from({ length: 10 }, (_, i) => `domain${i}.com`);
    const tools = {
        web_search: {
            allowed_domain: manyDomains
        }
    };

    const result = plugin.validateAndTransformTools(tools);

    t.is(result[0].filters.allowed_domains.length, 5);
});
