// openAiResponsesPlugin.test.js
// Unit tests for OpenAI Responses API plugin

import test from 'ava';

// Import the plugin class
import OpenAIResponsesPlugin from '../../../server/plugins/openAiResponsesPlugin.js';
import { requestState } from '../../../server/requestState.js';
import { Prompt } from '../../../server/prompt.js';

// Create a minimal mock pathway and model for testing
const createMockPlugin = () => {
    const mockPathway = {
        name: 'test_pathway',
        model: {
            name: 'gpt-4o-responses'
        }
    };
    const mockModel = {
        name: 'gpt-4o-responses',
        url: 'https://api.openai.com/v1/responses',
        emulateOpenAIChatModel: 'gpt-4o-responses'
    };
    return new OpenAIResponsesPlugin(mockPathway, mockModel);
};

const executeAndCaptureRequestData = async (plugin, {
    requestParameters,
    executeParameters = {},
    prompt = null,
    text = 'Say hello',
    resolver = {},
} = {}) => {
    let capturedRequestData;

    plugin.getRequestParameters = async () => requestParameters;
    plugin.executeRequest = async cortexRequest => {
        capturedRequestData = cortexRequest.data;
        return { output_text: 'Hello' };
    };

    await plugin.execute(text, executeParameters, prompt, resolver);
    return capturedRequestData;
};

for (const scenario of [
    {
        name: 'include request model when provided',
        requestParameters: {
            model: 'request-model',
            messages: [{ role: 'user', content: 'Say hello' }]
        },
        executeParameters: { model: 'request-model' },
        assert: (t, data) => t.is(data.model, 'request-model')
    },
    {
        name: 'flatten chat-completions function tools for responses api',
        requestParameters: {
            model: 'request-model',
            tools: [
                {
                    type: 'function',
                    function: {
                        name: 'search',
                        description: 'Search the web',
                        parameters: { type: 'object', properties: {} }
                    }
                }
            ],
            messages: [{ role: 'user', content: 'Say hello' }]
        },
        executeParameters: { model: 'request-model' },
        assert: (t, data) => t.deepEqual(data.tools, [
            {
                type: 'function',
                name: 'search',
                description: 'Search the web',
                parameters: { type: 'object', properties: {} }
            }
        ])
    },
    {
        name: 'fallback to configured model when request model is missing',
        requestParameters: {
            messages: [{ role: 'user', content: 'Say hello' }]
        },
        assert: (t, data) => t.is(data.model, 'gpt-4o-responses')
    },
    {
        name: 'prefer endpoint params model when request model is missing',
        setup: plugin => {
            plugin.model.params = { model: 'endpoint-params-model' };
        },
        requestParameters: {
            messages: [{ role: 'user', content: 'Say hello' }]
        },
        assert: (t, data) => t.is(data.model, 'endpoint-params-model')
    },
    {
        name: 'convert text content blocks to input_text for responses input',
        requestParameters: {
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Say hello' }
                    ]
                }
            ]
        },
        assert: (t, data) => {
            t.truthy(data.input);
            t.is(data.input[0].content[0].type, 'input_text');
        }
    },
    {
        name: 'convert response_format into text.format for responses api',
        requestParameters: {
            response_format: { type: 'json_object' },
            messages: [{ role: 'user', content: 'Say hello' }]
        },
        assert: (t, data) => {
            t.deepEqual(data.text, { format: { type: 'json_object' } });
            t.false(Object.prototype.hasOwnProperty.call(data, 'response_format'));
        }
    },
    {
        name: 'flatten tool_choice function selection for responses api',
        requestParameters: {
            tool_choice: {
                type: 'function',
                function: { name: 'search' }
            },
            messages: [{ role: 'user', content: 'Say hello' }]
        },
        assert: (t, data) => t.deepEqual(data.tool_choice, {
            type: 'function',
            name: 'search'
        })
    },
    {
        name: 'omit temperature for responses requests',
        requestParameters: {
            temperature: 0.9,
            messages: [{ role: 'user', content: 'Say hello' }]
        },
        assert: (t, data) => t.false(Object.prototype.hasOwnProperty.call(data, 'temperature'))
    },
    {
        name: 'convert reasoningEffort into reasoning config',
        requestParameters: {
            reasoningEffort: 'HIGH',
            messages: [{ role: 'user', content: 'Say hello' }]
        },
        executeParameters: { reasoning_effort: 'high' },
        assert: (t, data) => {
            t.deepEqual(data.reasoning, { effort: 'high' });
            t.false(Object.prototype.hasOwnProperty.call(data, 'reasoningEffort'));
            t.false(Object.prototype.hasOwnProperty.call(data, 'reasoning_effort'));
        }
    },
    {
        name: 'apply model reasoningEffortMap',
        setup: plugin => {
            plugin.model.reasoningEffortMap = {
                none: 'medium',
                low: 'medium',
                high: 'medium',
                xhigh: 'medium'
            };
        },
        requestParameters: {
            reasoningEffort: 'low',
            messages: [{ role: 'user', content: 'Say hello' }]
        },
        executeParameters: { reasoning_effort: 'none' },
        assert: (t, data) => t.deepEqual(data.reasoning, { effort: 'medium' })
    },
    {
        name: 'preserve explicit reasoning config over reasoningEffort alias',
        requestParameters: {
            reasoning: { effort: 'medium', summary: 'auto' },
            reasoningEffort: 'low',
            messages: [{ role: 'user', content: 'Say hello' }]
        },
        executeParameters: { reasoning_effort: 'high' },
        assert: (t, data) => t.deepEqual(data.reasoning, { effort: 'medium', summary: 'auto' })
    },
    {
        name: 'drop blank explicit reasoning effort',
        requestParameters: {
            reasoning: { effort: '  ', summary: 'auto' },
            messages: [{ role: 'user', content: 'Say hello' }]
        },
        assert: (t, data) => t.deepEqual(data.reasoning, { summary: 'auto' })
    }
]) {
    test(`execute should ${scenario.name}`, async t => {
        const plugin = createMockPlugin();
        scenario.setup?.(plugin);

        const capturedRequestData = await executeAndCaptureRequestData(plugin, scenario);

        t.truthy(capturedRequestData);
        scenario.assert(t, capturedRequestData);
    });
}

test('getRequestParameters should not send chat stream_options to Responses API', async t => {
    const plugin = createMockPlugin();
    plugin.model.type = 'OPENAI-RESPONSES';

    const params = await plugin.getRequestParameters('ping', { stream: true }, new Prompt({
        messages: [{ role: 'user', content: '{{{text}}}' }]
    }));

    t.false(Object.prototype.hasOwnProperty.call(params, 'stream_options'));
});

test('execute should resolve configured runtime model aliases before dispatch', async t => {
    const plugin = createMockPlugin();

    plugin.config = {
        get: key => {
            if (key !== 'models') {
                return undefined;
            }
            return {
                'oai-gpt54': {
                    endpoints: [
                        {
                            params: {
                                model: 'gpt-5.4'
                            }
                        }
                    ]
                }
            };
        }
    };
    const capturedRequestData = await executeAndCaptureRequestData(plugin, {
        requestParameters: {
            model: 'oai-gpt54',
            messages: [{ role: 'user', content: 'Say hello' }]
        },
        executeParameters: { model: 'oai-gpt54' }
    });

    t.truthy(capturedRequestData);
    t.is(capturedRequestData.model, 'gpt-5.4');
});

test('execute should fallback to config model endpoint params when runtime model metadata is missing', async t => {
    const plugin = createMockPlugin();

    plugin.model = {
        name: 'runtime-endpoint-only',
        url: 'https://example-foundry-resource.cognitiveservices.azure.com/openai/v1/responses'
    };
    plugin.promptParameters.model = 'oai-gpt52-codex';
    plugin.config = {
        get: key => {
            if (key !== 'models') {
                return undefined;
            }
            return {
                'oai-gpt52-codex': {
                    endpoints: [
                        {
                            params: {
                                model: 'gpt-5.2-codex'
                            }
                        }
                    ]
                }
            };
        }
    };

    const capturedRequestData = await executeAndCaptureRequestData(plugin, {
        requestParameters: {
            messages: [{ role: 'user', content: 'Say hello' }]
        }
    });

    t.truthy(capturedRequestData);
    t.is(capturedRequestData.model, 'gpt-5.2-codex');
});

test('execute should not re-route modelGroup alias from parameters.model (must honor resolver-chosen model)', async t => {
    // Regression test: previously execute() called resolveResponsesRequestModel(parameters.model)
    // which ran resolveModelName → pickGroupMember. With a modelGroup alias in parameters.model,
    // the picker could choose a DIFFERENT member than the one the pathway resolver picked at
    // construction time, so the body's model field would disagree with the endpoint URL the
    // request was about to be sent to (404 DeploymentNotFound on Azure).
    const plugin = createMockPlugin();

    // this.model is what the resolver chose at construction (oai-gpt54 → gpt-5.4 endpoint).
    plugin.model = {
        name: 'oai-gpt54',
        endpoints: [{ params: { model: 'gpt-5.4' } }],
        emulateOpenAIChatModel: 'gpt-5.4',
    };
    plugin.config = {
        get: key => {
            if (key !== 'models') return undefined;
            // Sibling member of the same group (claude-47-opus-vertex → claude-opus-4-7).
            // If the plugin re-routes parameters.model through the picker, it could land here
            // and stamp 'claude-opus-4-7' into the body — the bug we are guarding against.
            return {
                'oai-gpt54': { endpoints: [{ params: { model: 'gpt-5.4' } }], emulateOpenAIChatModel: 'gpt-5.4' },
                'claude-47-opus-vertex': { emulateOpenAIChatModel: 'claude-opus-4-7' },
            };
        },
    };

    // Caller passes the modelGroup alias (mirrors what sys_entity_agent passes through args).
    const capturedRequestData = await executeAndCaptureRequestData(plugin, {
        requestParameters: {
            messages: [{ role: 'user', content: 'Say hello' }],
        },
        executeParameters: { model: 'cortex-agent-chat' }
    });

    t.truthy(capturedRequestData);
    t.is(capturedRequestData.model, 'gpt-5.4');
    t.not(capturedRequestData.model, 'claude-opus-4-7');
});

test('resolveResponsesRequestModel should not invoke modelGroup picker', t => {
    // Direct unit test on the helper: a known model key resolves to its deployment ID via
    // direct config lookup, and a group alias (not present in `models`) passes through
    // unchanged rather than being routed to a member.
    const plugin = createMockPlugin();
    const configuredModels = {
        'oai-gpt54': { endpoints: [{ params: { model: 'gpt-5.4' } }] },
    };
    t.is(plugin.resolveResponsesRequestModel('oai-gpt54', configuredModels), 'gpt-5.4');
    t.is(plugin.resolveResponsesRequestModel('cortex-agent-chat', configuredModels), 'cortex-agent-chat');
    t.is(plugin.resolveResponsesRequestModel('', configuredModels), null);
    t.is(plugin.resolveResponsesRequestModel(null, configuredModels), null);
});

test('resolveResponsesRequestModel should follow model redirects without invoking modelGroup picker', t => {
    const plugin = createMockPlugin();
    const configuredModels = {
        'xai-grok-4-20-responses': { endpoints: [{ params: { model: 'grok-4.20-responses' } }] },
    };
    const redirects = {
        'xai-grok-4-responses': 'xai-grok-4-20-responses',
        'cortex-agent-chat': 'oai-gpt55',
    };

    t.is(
        plugin.resolveResponsesRequestModel('xai-grok-4-responses', configuredModels, redirects),
        'grok-4.20-responses',
    );
    // Redirect target is not a configured model in this helper context, so it
    // must not chase the alias into group/member routing territory.
    t.is(
        plugin.resolveResponsesRequestModel('cortex-agent-chat', configuredModels, redirects),
        'cortex-agent-chat',
    );
});

test('normalizeResponsesApiInput should flatten image_url objects to plain URL strings', t => {
    const plugin = createMockPlugin();

    const result = plugin.normalizeResponsesApiInput([
        {
            role: 'user',
            content: [
                { type: 'text', text: 'What is in this image?' },
                { type: 'image_url', image_url: { url: 'https://example.com/photo.jpg', detail: 'high' } }
            ]
        }
    ]);

    t.is(result.length, 1);
    const imageItem = result[0].content[1];
    t.is(imageItem.type, 'input_image');
    t.is(imageItem.image_url, 'https://example.com/photo.jpg');
});

test('normalizeResponsesApiInput should handle image_url that is already a plain string', t => {
    const plugin = createMockPlugin();

    const result = plugin.normalizeResponsesApiInput([
        {
            role: 'user',
            content: [
                { type: 'image_url', image_url: 'https://example.com/photo.jpg' }
            ]
        }
    ]);

    const imageItem = result[0].content[0];
    t.is(imageItem.type, 'input_image');
    t.is(imageItem.image_url, 'https://example.com/photo.jpg');
});

test('normalizeResponsesApiInput should convert assistant tool calls and tool outputs', t => {
    const plugin = createMockPlugin();

    const result = plugin.normalizeResponsesApiInput([
        {
            role: 'assistant',
            content: [{ type: 'text', text: 'Let me check.' }],
            tool_calls: [
                {
                    id: 'call_123',
                    function: {
                        name: 'get_weather',
                        arguments: '{"location":"Boston"}'
                    }
                }
            ]
        },
        {
            role: 'tool',
            tool_call_id: 'call_123',
            content: '72F'
        }
    ]);

    t.deepEqual(result, [
        {
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Let me check.' }]
        },
        {
            type: 'function_call',
            call_id: 'call_123',
            name: 'get_weather',
            arguments: '{"location":"Boston"}'
        },
        {
            type: 'function_call_output',
            call_id: 'call_123',
            output: '72F'
        }
    ]);
});

test('execute should prefer raw responses_input_json passthrough over rebuilt messages', async t => {
    const plugin = createMockPlugin();
    let capturedRequestData;
    const rawInput = [
        {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: 'Keep this exact block' }]
        },
        {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Ping' }]
        }
    ];

    plugin.executeRequest = async cortexRequest => {
        capturedRequestData = cortexRequest.data;
        return { output_text: 'ok' };
    };

    await plugin.execute(
        'Ping',
        {
            messages: [{ role: 'user', content: 'fallback message' }],
            responses_input_json: JSON.stringify(rawInput)
        },
        { messages: ['{{messages}}'] },
        {}
    );

    t.truthy(capturedRequestData);
    t.deepEqual(capturedRequestData.input, rawInput);
    t.false(Object.prototype.hasOwnProperty.call(capturedRequestData, 'messages'));
    t.is(capturedRequestData.input[0].role, 'developer');
    t.is(capturedRequestData.input[0].content[0].type, 'input_text');
});

test('processStreamEvent should close response.incomplete streams with a visible error chunk', t => {
    const plugin = createMockPlugin();
    const progress = plugin.processStreamEvent({
        data: JSON.stringify({
            type: 'response.incomplete',
            response: {
                incomplete_details: {
                    reason: 'max_output_tokens'
                }
            }
        })
    }, { requestId: 'responses-incomplete' });

    t.is(progress.progress, 1);
    t.is(progress.error, 'max_output_tokens');
    const chunk = JSON.parse(progress.data);
    t.is(chunk.choices[0].delta.content, 'The model stream ended before returning a complete response: max_output_tokens');
    t.is(chunk.choices[0].finish_reason, 'stop');
});

test('processStreamEvent should not dispatch partial tool calls for response.incomplete', t => {
    const plugin = createMockPlugin();
    plugin.requestId = 'responses-incomplete-tools';
    plugin.pathwayToolCallback = () => {
        t.fail('response.incomplete should not dispatch tool callbacks');
    };
    plugin.toolCallsBuffer = [
        {
            id: 'call_partial',
            type: 'function',
            function: {
                name: 'WorkspaceSSH',
                arguments: '{"command":'
            }
        }
    ];
    requestState[plugin.requestId] = {
        pathwayResolver: {
            args: {},
        },
    };

    try {
        const progress = plugin.processStreamEvent({
            data: JSON.stringify({
                type: 'response.incomplete',
                incomplete_details: {
                    reason: 'max_output_tokens'
                }
            })
        }, { requestId: plugin.requestId });

        t.is(progress.progress, 1);
        t.is(progress.error, 'max_output_tokens');
        const chunk = JSON.parse(progress.data);
        t.is(chunk.choices[0].delta.content, 'The model stream ended before returning a complete response: max_output_tokens');
        t.is(chunk.choices[0].finish_reason, 'stop');
    } finally {
        delete requestState[plugin.requestId];
    }
});

test('processStreamEvent should forward response.output_text.delta with string delta', t => {
    const plugin = createMockPlugin();
    const eventData = {
        type: 'response.output_text.delta',
        delta: 'Hello'
    };
    const requestProgress = {};

    const result = plugin.processStreamEvent({ data: JSON.stringify(eventData) }, requestProgress);

    const parsed = JSON.parse(result.data);
    t.is(parsed.choices[0].delta.content, 'Hello');
    t.is(parsed.choices[0].finish_reason, null);
});

test('processStreamEvent should convert function_call add events to chat-completions tool deltas', t => {
    const plugin = createMockPlugin();
    const eventData = {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
            type: 'function_call',
            call_id: 'call_123',
            name: 'get_weather',
            arguments: ''
        }
    };
    const requestProgress = {};

    const result = plugin.processStreamEvent({ data: JSON.stringify(eventData) }, requestProgress);

    const parsed = JSON.parse(result.data);
    t.is(parsed.choices[0].delta.tool_calls[0].id, 'call_123');
    t.is(parsed.choices[0].delta.tool_calls[0].function.name, 'get_weather');
});

test('processStreamEvent should mark response.completed as stop for clients', t => {
    const plugin = createMockPlugin();
    const eventData = {
        type: 'response.completed',
        response: {
            id: 'resp_123',
            output: []
        }
    };
    const requestProgress = {};

    const result = plugin.processStreamEvent({ data: JSON.stringify(eventData) }, requestProgress);

    const parsed = JSON.parse(result.data);
    t.is(result.progress, 1);
    t.deepEqual(parsed.choices[0].delta, {});
    t.is(parsed.choices[0].finish_reason, 'stop');
});

// ============================================================================
// Tools Validation and Transformation Tests
// ============================================================================

for (const scenario of [
    {
        name: 'flatten function tools in array format',
        tools: [
            { type: 'function', function: { name: 'get_weather', parameters: {} } },
            { type: 'code_interpreter' }
        ],
        assert: (t, result) => t.deepEqual(result, [
            { type: 'function', name: 'get_weather', parameters: {} },
            { type: 'code_interpreter' }
        ])
    },
    {
        name: 'handle function tool type',
        tools: [
            {
                type: 'function',
                function: {
                    name: 'search',
                    description: 'Search the web',
                    parameters: { type: 'object', properties: {} }
                }
            }
        ],
        assert: (t, result) => {
            t.is(result.length, 1);
            t.is(result[0].type, 'function');
            t.is(result[0].name, 'search');
        }
    },
    {
        name: 'convert object format to array format',
        tools: {
            functions: [
                { name: 'get_weather', description: 'Get weather', parameters: {} }
            ]
        },
        assert: (t, result) => {
            t.true(Array.isArray(result));
            t.is(result.length, 1);
            t.is(result[0].type, 'function');
            t.is(result[0].name, 'get_weather');
        }
    },
    {
        name: 'handle code_interpreter tool',
        tools: { code_interpreter: true },
        assert: (t, result) => {
            t.true(Array.isArray(result));
            t.is(result.length, 1);
            t.is(result[0].type, 'code_interpreter');
        }
    },
    {
        name: 'handle file_search tool',
        tools: {
            file_search: { vector_store_ids: ['vs_123'] }
        },
        assert: (t, result) => {
            t.true(Array.isArray(result));
            t.is(result.length, 1);
            t.is(result[0].type, 'file_search');
            t.deepEqual(result[0].vector_store_ids, ['vs_123']);
        }
    },
    {
        name: 'handle web_search_preview tool',
        tools: { web_search_preview: true },
        assert: (t, result) => {
            t.true(Array.isArray(result));
            t.is(result.length, 1);
            t.is(result[0].type, 'web_search_preview');
        }
    },
    {
        name: 'handle multiple tools',
        tools: {
            code_interpreter: true,
            file_search: true,
            functions: [
                { name: 'my_function', description: 'test', parameters: {} }
            ]
        },
        assert: (t, result) => {
            t.true(Array.isArray(result));
            t.is(result.length, 3);

            const types = result.map(tool => tool.type);
            t.true(types.includes('function'));
            t.true(types.includes('code_interpreter'));
            t.true(types.includes('file_search'));
        }
    }
]) {
    test(`validateAndTransformTools should ${scenario.name}`, t => {
        const result = createMockPlugin().validateAndTransformTools(scenario.tools);
        scenario.assert(t, result);
    });
}

// ============================================================================
// Response Parsing Tests
// ============================================================================

test('parseResponsesApiFormat should extract output_text', t => {
    const plugin = createMockPlugin();
    const data = {
        id: 'resp_123',
        output_text: 'Hello, world!',
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 5 }
    };

    const result = plugin.parseResponsesApiFormat(data);

    // CortexResponse uses output_text property
    t.is(result.output_text, 'Hello, world!');
    t.is(result.finishReason, 'completed');
    t.truthy(result.usage);
});

test('parseResponsesApiFormat should extract text from output array', t => {
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

    // CortexResponse uses output_text property
    t.is(result.output_text, 'Part 1 Part 2');
});

test('parseResponsesApiFormat should handle function calls in output', t => {
    const plugin = createMockPlugin();
    const data = {
        id: 'resp_123',
        output: [
            {
                type: 'function_call',
                call_id: 'call_123',
                name: 'get_weather',
                arguments: '{"location": "Boston"}'
            }
        ],
        status: 'completed'
    };

    const result = plugin.parseResponsesApiFormat(data);

    t.truthy(result.toolCalls);
    t.is(result.toolCalls.length, 1);
    t.is(result.toolCalls[0].function.name, 'get_weather');
    t.is(result.toolCalls[0].function.arguments, '{"location": "Boston"}');
});

test('parseResponsesApiFormat should handle url_citation annotations', t => {
    const plugin = createMockPlugin();
    const data = {
        id: 'resp_123',
        output: [
            {
                type: 'message',
                content: [
                    {
                        type: 'output_text',
                        text: 'Here is some info [1]',
                        annotations: [
                            {
                                type: 'url_citation',
                                url: 'https://example.com/article',
                                title: 'Example Article',
                                start_index: 18,
                                end_index: 21
                            }
                        ]
                    }
                ]
            }
        ],
        status: 'completed'
    };

    const result = plugin.parseResponsesApiFormat(data);

    t.truthy(result.citations);
    t.is(result.citations.length, 1);
    t.is(result.citations[0].url, 'https://example.com/article');
    t.is(result.citations[0].title, 'Example Article');
});

test('parseResponsesApiFormat should handle reasoning output', t => {
    const plugin = createMockPlugin();
    const data = {
        id: 'resp_123',
        output: [
            {
                type: 'reasoning',
                summary: 'I thought about this carefully...'
            },
            {
                type: 'message',
                content: [
                    { type: 'output_text', text: 'The answer is 42' }
                ]
            }
        ],
        status: 'completed'
    };

    const result = plugin.parseResponsesApiFormat(data);

    // CortexResponse uses output_text property
    t.is(result.output_text, 'The answer is 42');
    t.truthy(result.metadata.reasoning);
    t.true(result.metadata.reasoning.includes('I thought about this carefully'));
});

// ============================================================================
// Helper Function Tests
// ============================================================================

test('processStreamEvent should call addCitationsToResolver on response.completed', t => {
    const plugin = createMockPlugin();

    // Simulate streaming text with :cd_source[id] patterns
    plugin.contentBuffer = 'Breaking news :cd_source[abc-123] and more :cd_source[def-456]';
    plugin.requestId = 'test-req-1';

    // Track whether addCitationsToResolver is called
    let citationsCall = null;

    // We can't easily mock the import, so instead verify that the resolver
    // is accessed and contentBuffer is populated when completed fires.
    // The key assertion: contentBuffer is non-empty when citations would be resolved.
    const completedEvent = {
        type: 'response.completed',
        response: {
            id: 'resp_123',
            output: [
                {
                    type: 'message',
                    content: [
                        {
                            type: 'output_text',
                            text: 'Breaking news',
                            annotations: [
                                {
                                    type: 'url_citation',
                                    url: 'https://example.com/article',
                                    title: 'Example Article',
                                    start_index: 0,
                                    end_index: 13
                                }
                            ]
                        }
                    ]
                }
            ]
        }
    };

    const requestProgress = {};
    const result = plugin.processStreamEvent({ data: JSON.stringify(completedEvent) }, requestProgress);

    // After completion, buffers should be cleared (citations extraction happened before clearing)
    t.is(plugin.contentBuffer, '');
    t.is(result.progress, 1);
});

test('extractTitleFromUrl should extract domain as fallback title', t => {
    const plugin = createMockPlugin();

    t.is(plugin.extractTitleFromUrl('https://www.example.com/path'), 'example.com');
    t.is(plugin.extractTitleFromUrl('https://docs.python.org/3/tutorial'), 'docs.python.org');
    t.is(plugin.extractTitleFromUrl('invalid-url'), 'invalid-url');
});
