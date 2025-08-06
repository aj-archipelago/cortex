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
        agentId: 'asst_pwiNrsjXR2xEBn2aRcYkdkkN',
        headers: {
            'Content-Type': 'application/json'
        },
        maxTokenLength: 32768,
        maxReturnTokens: 4096,
        supportsStreaming: true
    };

    t.context.plugin = new AzureFoundryAgentsPlugin(mockPathway, mockModel);
    t.context.mockPathway = mockPathway;
    t.context.mockModel = mockModel;
});

test('should initialize with correct agent ID and project URL', t => {
    const { plugin } = t.context;
    t.is(plugin.agentId, 'asst_pwiNrsjXR2xEBn2aRcYkdkkN');
    t.is(plugin.projectUrl, 'https://archipelago-foundry-resource.services.ai.azure.com/api/projects/archipelago-foundry');
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

    const result = plugin.getRequestParameters(text, parameters, prompt);

    t.is(result.assistant_id, 'asst_pwiNrsjXR2xEBn2aRcYkdkkN');
    t.deepEqual(result.thread.messages, [{ role: 'user', content: text }]);
    t.is(result.stream, false);
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
    t.is(url, 'https://archipelago-foundry-resource.services.ai.azure.com/api/projects/archipelago-foundry/threads/runs');
});

test('should handle polling for run completion', async t => {
    const { plugin } = t.context;
    
    // Mock the executeRequest method to simulate polling
    const originalExecuteRequest = plugin.executeRequest;
    let callCount = 0;
    
    plugin.executeRequest = async (request) => {
        callCount++;
        if (callCount === 1) {
            // First call - return run response
            return {
                id: 'run_123',
                thread_id: 'thread_456',
                status: 'in_progress'
            };
        } else if (callCount === 2) {
            // Second call - return completed status
            return {
                id: 'run_123',
                thread_id: 'thread_456',
                status: 'completed'
            };
        } else if (callCount === 3) {
            // Third call - return messages
            return {
                data: [
                    {
                        role: 'user',
                        content: [{ type: 'text', text: { value: 'Hello' } }]
                    },
                    {
                        role: 'assistant',
                        content: [{ type: 'text', text: { value: 'Hi there! How can I help you?' } }]
                    }
                ]
            };
        }
        return null;
    };
    
    try {
        const result = await plugin.pollForCompletion('thread_456', 'run_123', {});
        t.is(result, 'Hi there! How can I help you?');
        t.is(callCount, 3);
    } finally {
        plugin.executeRequest = originalExecuteRequest;
    }
});

test('should handle run failure during polling', async t => {
    const { plugin } = t.context;
    
    // Mock the executeRequest method to simulate failed run
    const originalExecuteRequest = plugin.executeRequest;
    let callCount = 0;
    
    plugin.executeRequest = async (request) => {
        callCount++;
        if (callCount === 1) {
            return {
                id: 'run_123',
                thread_id: 'thread_456',
                status: 'failed',
                lastError: { message: 'Something went wrong' }
            };
        }
        return null;
    };
    
    try {
        const result = await plugin.pollForCompletion('thread_456', 'run_123', {});
        t.is(result, null);
        t.is(callCount, 1);
    } finally {
        plugin.executeRequest = originalExecuteRequest;
    }
}); 