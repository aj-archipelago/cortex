import test from 'ava';
import OpenAIChatPlugin from '../graphql/plugins/openAiChatPlugin.js';
import { mockConfig, mockPathwayString, mockPathwayFunction, mockPathwayMessages } from './mocks.js';

// Test the constructor
test('constructor', (t) => {
    const plugin = new OpenAIChatPlugin(mockConfig, mockPathwayString);
    t.is(plugin.config, mockConfig);
    t.is(plugin.pathwayPrompt, mockPathwayString.prompt);
});

// Test the convertPalmToOpenAIMessages function
test('convertPalmToOpenAIMessages', (t) => {
    const plugin = new OpenAIChatPlugin(mockConfig, mockPathwayString);
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
    const plugin = new OpenAIChatPlugin(mockConfig, mockPathwayString);
    const text = 'Help me';
    const parameters = { name: 'John', age: 30 };
    const prompt = mockPathwayString.prompt;
    const result = await plugin.getRequestParameters(text, parameters, prompt);
    t.deepEqual(result, {
        messages: [
            { role: 'user', content: 'User: Help me\nAssistant: Please help John who is 30 years old.' },
        ],
        temperature: 0.7,
    });
});

// Test the execute function
test('execute', async (t) => {
    const plugin = new OpenAIChatPlugin(mockConfig, mockPathwayString);
    const text = 'Help me';
    const parameters = { name: 'John', age: 30 };
    const prompt = mockPathwayString.prompt;

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

    const result = await plugin.execute(text, parameters, prompt);
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
    const plugin = new OpenAIChatPlugin(mockConfig, mockPathwayString);
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
    t.is(result, 'Sure, I can help John who is 30 years old.');
});

// Test the logRequestData function
test('logRequestData', (t) => {
    const plugin = new OpenAIChatPlugin(mockConfig, mockPathwayString);
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
    const prompt = mockPathwayString.prompt;

    // Mock console.log function
    const originalConsoleLog = console.log;
    console.log = () => {};

    t.notThrows(() => plugin.logRequestData(data, responseData, prompt));

    console.log = originalConsoleLog;
});