import test from 'ava';
import OpenAIChatPlugin from '../../../server/plugins/openAiChatPlugin.js';
import { mockPathwayResolverMessages } from '../../helpers/mocks.js';
import { config } from '../../../config.js';

const { pathway, modelName, model } = mockPathwayResolverMessages;

// Test the constructor
test('constructor', (t) => {
    const plugin = new OpenAIChatPlugin(pathway, model);
    t.is(plugin.config, config);
    t.is(plugin.pathwayPrompt, mockPathwayResolverMessages.pathway.prompt);
});

// Test the convertPalmToOpenAIMessages function
test('convertPalmToOpenAIMessages', (t) => {
    const plugin = new OpenAIChatPlugin(pathway, model);
    const context = 'This is a test context.';
    const examples = [
        {
            input: { author: 'user', content: 'Hello' },
            output: { author: 'assistant', content: 'Hi there!' },
        },
    ];
    const messages = [
        { author: 'user', content: 'How are you?' },
        { author: 'assistant', content: 'I am doing well, thank you!' },
    ];
    const result = plugin.convertPalmToOpenAIMessages(context, examples, messages);
    t.deepEqual(result, [
        { role: 'system', content: 'This is a test context.' },
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
        { role: 'assistant', content: 'I am doing well, thank you!' },
    ]);
});

// Test the getRequestParameters function
test('getRequestParameters', async (t) => {
    const plugin = new OpenAIChatPlugin(pathway, model);
    const text = 'Help me';
    const parameters = { name: 'John', age: 30 };
    const prompt = mockPathwayResolverMessages.pathway.prompt;
    const result = await plugin.getRequestParameters(text, parameters, prompt);
    t.deepEqual(result, {
        messages: [
            {
                content: 'Translate this: Help me',
                role: 'user',
            },
            {
                content: 'Translating: Help me',
                role: 'assistant',
            },
            {
                content: 'Nice work!',
                role: 'user',
            },
        ],
        temperature: 0.7,
    });
});

test('getRequestParameters requests usage for OpenAI-family streams', async (t) => {
    const plugin = new OpenAIChatPlugin(pathway, model);
    const result = await plugin.getRequestParameters('Help me', { stream: true }, mockPathwayResolverMessages.pathway.prompt);

    t.deepEqual(result.stream_options, { include_usage: true });
});

test('getRequestParameters does not request stream usage for non-OpenAI adapters', async (t) => {
    const plugin = new OpenAIChatPlugin(pathway, { ...model, type: 'KIMI-CHAT' });
    const result = await plugin.getRequestParameters('Help me', { stream: true }, mockPathwayResolverMessages.pathway.prompt);

    t.is(result.stream_options, undefined);
});

test('processStreamEvent does not complete stream on finish_reason before DONE', (t) => {
    const plugin = new OpenAIChatPlugin(pathway, model);
    const finishEvent = {
        data: JSON.stringify({
            choices: [
                {
                    delta: {},
                    finish_reason: 'stop',
                },
            ],
        }),
    };
    const usageEvent = {
        data: JSON.stringify({
            choices: [],
            usage: {
                prompt_tokens: 10,
                completion_tokens: 2,
                total_tokens: 12,
            },
        }),
    };

    const afterFinish = plugin.processStreamEvent(finishEvent, { requestId: 'req_1' });
    t.is(afterFinish.progress, undefined);
    t.is(afterFinish.data, finishEvent.data);

    const afterUsage = plugin.processStreamEvent(usageEvent, { requestId: 'req_1' });
    t.is(afterUsage.progress, undefined);
    t.is(afterUsage.data, undefined);

    const afterDone = plugin.processStreamEvent({ data: '[DONE]' }, { requestId: 'req_1' });
    t.is(afterDone.progress, 1);
});

test('processStreamEvent waits for DONE when usage is not expected', (t) => {
    const plugin = new OpenAIChatPlugin(pathway, model);
    const finishEvent = {
        data: JSON.stringify({
            choices: [
                {
                    delta: {},
                    finish_reason: 'stop',
                },
            ],
        }),
    };

    const afterFinish = plugin.processStreamEvent(finishEvent, { requestId: 'req_1' });

    t.is(afterFinish.progress, undefined);
    t.is(afterFinish.data, finishEvent.data);
});

// Test the execute function
test('execute', async (t) => {
    const plugin = new OpenAIChatPlugin(pathway, model);
    const text = 'Help me';
    const parameters = { name: 'John', age: 30 };
    const prompt = mockPathwayResolverMessages.pathway.prompt;

    // Mock the executeRequest function
    plugin.executeRequest = () => {
        return {
            choices: [
                {
                    message: {
                        content: 'Sure, I can help John who is 30 years old.',
                    },
                },
            ],
        };
    };

    const result = await plugin.execute(text, parameters, prompt, { requestId: 'foo', pathway: {} });
    t.deepEqual(result, {
        choices: [
            {
                message: {
                    content: 'Sure, I can help John who is 30 years old.',
                },
            },
        ],
    });
});

// Test the parseResponse function
test('parseResponse', (t) => {
    const plugin = new OpenAIChatPlugin(pathway, model);
    const data = {
        choices: [
            {
                message: {
                    content: 'Sure, I can help John who is 30 years old.',
                },
            },
        ],
    };
    const result = plugin.parseResponse(data);
    
    // Verify it's a CortexResponse object
    t.truthy(result);
    t.is(typeof result, 'object');
    t.is(result.constructor.name, 'CortexResponse');
    
    
    // Verify the content using string conversion (triggers toString automatically)
    t.is(String(result), 'Sure, I can help John who is 30 years old.');
    t.is(result.finishReason, 'stop');
});

// Test the logRequestData function
test('logRequestData', (t) => {
    const plugin = new OpenAIChatPlugin(pathway, model);
    const data = {
        messages: [
            { role: 'user', content: 'User: Help me\nAssistant: Please help John who is 30 years old.' },
        ],
    };
    const responseData = {
        choices: [
            {
                message: {
                    content: 'Sure, I can help John who is 30 years old.',
                },
            },
        ],
    };
    const prompt = mockPathwayResolverMessages.pathway.prompt;

    // Mock console.log function
    const originalConsoleLog = console.log;
    console.log = () => {};

    t.notThrows(() => plugin.logRequestData(data, responseData, prompt));

    console.log = originalConsoleLog;
});
