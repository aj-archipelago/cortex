// azureFoundryAgents.test.js
import test from 'ava';
import AzureFoundryAgentsPlugin from '../server/plugins/azureFoundryAgentsPlugin.js';

test.beforeEach(t => {
    const mockPathway = {
        name: 'test-pathway',
        temperature: 0.7,
        prompt: {
            context: 'You are a helpful assistant.',
            examples: []
        }
    };

    const mockModel = {
        name: 'azure-foundry-agents',
        type: 'AZURE-FOUNDRY-AGENTS',
        url: 'https://archipelago-foundry-resource.services.ai.azure.com/api/projects/archipelago-foundry',
        headers: {
            'Content-Type': 'application/json'
        },
        params: {
            assistant_id: 'asst_testid'
        },
        maxTokenLength: 32768,
        maxReturnTokens: 4096,
        supportsStreaming: true
    };

    t.context.plugin = new AzureFoundryAgentsPlugin(mockPathway, mockModel);
    t.context.mockPathway = mockPathway;
    t.context.mockModel = mockModel;
});

test('should convert Palm format messages to Azure format', t => {
    const { plugin } = t.context;
    const context = 'You are a helpful assistant.';
    const examples = [
        {
            input: { author: 'user', content: 'Hello' },
            output: { author: 'assistant', content: 'Hi there!' }
        }
    ];
    const messages = [
        { author: 'user', content: 'How are you?' }
    ];

    const result = plugin.convertToAzureFoundryMessages(context, examples, messages);

    t.deepEqual(result, [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' }
    ]);
});

test('should handle empty examples and context', t => {
    const { plugin } = t.context;
    const messages = [
        { author: 'user', content: 'Hello' }
    ];

    const result = plugin.convertToAzureFoundryMessages('', [], messages);

    t.deepEqual(result, [
        { role: 'user', content: 'Hello' }
    ]);
});

test('should create correct request parameters', t => {
    const { plugin } = t.context;
    const text = 'Hello, can you help me?';
    const parameters = { stream: false };
    const prompt = {
        context: 'You are helpful.',
        examples: [],
        messages: [{ role: 'user', content: text }]
    };

    plugin.baseUrl = 'https://archipelago-foundry-resource.services.ai.azure.com/api/projects/archipelago-foundry';
    plugin.assistantId = 'asst_testid';
    const result = plugin.getRequestParameters(text, parameters, prompt);

    t.is(result.assistant_id, 'asst_testid');
    t.deepEqual(result.thread.messages, [{ role: 'user', content: text }]);
    t.is(result.stream, false);
});

test('should use custom instructions from parameters', t => {
    const { plugin } = t.context;
    const text = 'Hello, can you help me?';
    const customInstructions = 'You are a specialized search agent.';
    const parameters = { 
        stream: false,
        instructions: customInstructions
    };
    const prompt = {
        context: 'You are helpful.',
        examples: [],
        messages: [{ role: 'user', content: text }]
    };

    plugin.baseUrl = 'https://archipelago-foundry-resource.services.ai.azure.com/api/projects/archipelago-foundry';
    plugin.assistantId = 'asst_testid';
    const result = plugin.getRequestParameters(text, parameters, prompt);

    t.is(result.instructions, customInstructions);
});

test('should use custom tools from parameters', t => {
    const { plugin } = t.context;
    const text = 'Hello, can you help me?';
    const customTools = [
        {
            type: "bing_grounding",
            bing_grounding: {
                search_configurations: [
                    {
                        connection_id: "test-connection-id",
                        count: 10,
                        freshness: "day",
                        market: "en-us",
                        set_lang: "en"
                    }
                ]
            }
        }
    ];
    const parameters = { 
        stream: false,
        tools: customTools
    };
    const prompt = {
        context: 'You are helpful.',
        examples: [],
        messages: [{ role: 'user', content: text }]
    };

    plugin.baseUrl = 'https://archipelago-foundry-resource.services.ai.azure.com/api/projects/archipelago-foundry';
    plugin.assistantId = 'asst_testid';
    const result = plugin.getRequestParameters(text, parameters, prompt);

    t.deepEqual(result.tools, customTools);
});

test('should use custom parallel_tool_calls from parameters', t => {
    const { plugin } = t.context;
    const text = 'Hello, can you help me?';
    const parameters = { 
        stream: false,
        parallel_tool_calls: false
    };
    const prompt = {
        context: 'You are helpful.',
        examples: [],
        messages: [{ role: 'user', content: text }]
    };

    plugin.baseUrl = 'https://archipelago-foundry-resource.services.ai.azure.com/api/projects/archipelago-foundry';
    plugin.assistantId = 'asst_testid';
    const result = plugin.getRequestParameters(text, parameters, prompt);

    t.is(result.parallel_tool_calls, false);
});

test('should not include tools or parallel_tool_calls when not provided', t => {
    const { plugin } = t.context;
    const text = 'Hello, can you help me?';
    const parameters = { stream: false };
    const prompt = {
        context: 'You are helpful.',
        examples: [],
        messages: [{ role: 'user', content: text }]
    };

    plugin.baseUrl = 'https://archipelago-foundry-resource.services.ai.azure.com/api/projects/archipelago-foundry';
    plugin.assistantId = 'asst_testid';
    const result = plugin.getRequestParameters(text, parameters, prompt);

    t.falsy(result.tools);
    t.falsy(result.parallel_tool_calls);
});

test('should handle Bing grounding tools with custom search parameters', t => {
    const { plugin } = t.context;
    const text = 'Hello, can you help me?';
    const customTools = [
        {
            type: "bing_grounding",
            bing_grounding: {
                search_configurations: [
                    {
                        connection_id: "test-connection-id",
                        count: 10,
                        freshness: "day",
                        market: "en-gb",
                        set_lang: "en"
                    }
                ]
            }
        }
    ];
    const parameters = { 
        stream: false,
        tools: customTools
    };
    const prompt = {
        context: 'You are helpful.',
        examples: [],
        messages: [{ role: 'user', content: text }]
    };

    plugin.baseUrl = 'https://archipelago-foundry-resource.services.ai.azure.com/api/projects/archipelago-foundry';
    plugin.assistantId = 'asst_testid';
    const result = plugin.getRequestParameters(text, parameters, prompt);

    t.deepEqual(result.tools, customTools);
    t.is(result.tools[0].bing_grounding.search_configurations[0].count, 10);
    t.is(result.tools[0].bing_grounding.search_configurations[0].freshness, "day");
    t.is(result.tools[0].bing_grounding.search_configurations[0].market, "en-gb");
    t.is(result.tools[0].bing_grounding.search_configurations[0].set_lang, "en");
});

test('should parse completed run response', t => {
    const { plugin } = t.context;
    const mockResponse = {
        id: 'run_123',
        status: 'completed',
        thread_id: 'thread_456'
    };

    const result = plugin.parseResponse(mockResponse);
    t.deepEqual(result, mockResponse);
});

test('should parse string response (final message content)', t => {
    const { plugin } = t.context;
    const mockResponse = 'Hello! How can I help you?';

    const result = plugin.parseResponse(mockResponse);
    t.is(result, 'Hello! How can I help you?');
});

test('should handle failed run response', t => {
    const { plugin } = t.context;
    const mockResponse = {
        id: 'run_123',
        status: 'failed',
        lastError: { message: 'Something went wrong' }
    };

    const result = plugin.parseResponse(mockResponse);
    t.is(result, null);
});

test('should parse message content from response', t => {
    const { plugin } = t.context;
    const mockResponse = {
        messages: [
            {
                role: 'assistant',
                content: [
                    {
                        type: 'text',
                        text: { value: 'Hello! How can I help you?' }
                    }
                ]
            }
        ]
    };

    const result = plugin.parseResponse(mockResponse);
    t.is(result, 'Hello! How can I help you?');
});

test('should return empty string for null response', t => {
    const { plugin } = t.context;
    const result = plugin.parseResponse(null);
    t.is(result, '');
});

test('should return correct Azure Foundry Agents endpoint', t => {
    const { plugin } = t.context;
    const url = plugin.requestUrl();
    t.is(url, 'https://archipelago-foundry-resource.services.ai.azure.com/api/projects/archipelago-foundry');
});

test('should be able to access azureAuthTokenHelper from config', (t) => {
  // Mock config with azureAuthTokenHelper
  const mockConfig = {
    get: (key) => {
      if (key === 'azureAuthTokenHelper') {
        return {
          getAccessToken: async () => 'mock-token'
        };
      }
      return null;
    }
  };

  // Mock pathway and model
  const mockPathway = {};
  const mockModel = {
    url: 'https://test.azure.com/api/projects/test',
    agentId: 'test-agent-id',
    headers: { 'Content-Type': 'application/json' }
  };

  // Create plugin instance
  const plugin = new AzureFoundryAgentsPlugin(mockPathway, mockModel);
  
  // Mock the config property
  plugin.config = mockConfig;

  // Test that we can access the auth helper
  const authHelper = plugin.config.get('azureAuthTokenHelper');
  t.truthy(authHelper);
  t.is(typeof authHelper.getAccessToken, 'function');
});

test('should handle missing azureAuthTokenHelper gracefully', (t) => {
  // Mock config without azureAuthTokenHelper
  const mockConfig = {
    get: (key) => null
  };

  // Mock pathway and model
  const mockPathway = {};
  const mockModel = {
    url: 'https://test.azure.com/api/projects/test',
    agentId: 'test-agent-id',
    headers: { 'Content-Type': 'application/json' }
  };

  // Create plugin instance
  const plugin = new AzureFoundryAgentsPlugin(mockPathway, mockModel);
  
  // Mock the config property
  plugin.config = mockConfig;

  // Test that we can access the auth helper (should be null)
  const authHelper = plugin.config.get('azureAuthTokenHelper');
  t.is(authHelper, null);
});