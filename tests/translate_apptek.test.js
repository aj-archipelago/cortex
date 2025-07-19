import test from 'ava';
import sinon from 'sinon';
import { PathwayResolver } from '../server/pathwayResolver.js';

// Mock configuration
const mockModel = {
    name: 'apptek-translate',
    type: 'APPTEK-TRANSLATE',
    apiEndpoint: 'https://api.mock-apptek.com',
    apiKey: 'mock-api-key'
};

test.beforeEach((t) => {
    // Create a sinon sandbox
    t.context.sandbox = sinon.createSandbox();

    // Save original environment variables
    t.context.originalEnv = { ...process.env };
    
    // Set environment variables for testing
    process.env.APPTEK_API_ENDPOINT = 'https://api.mock-apptek.com';
    process.env.APPTEK_API_KEY = 'mock-api-key';
    
    // Create config mock
    t.context.mockConfig = {
        get: (key) => {
            const configs = {
                models: {
                    'apptek-translate': mockModel
                },
                'models.apptek-translate': mockModel,
                defaultModelName: 'apptek-translate',
                environmentVariables: {
                    APPTEK_API_ENDPOINT: 'https://api.mock-apptek.com',
                    APPTEK_API_KEY: 'mock-api-key'
                }
            };
            return configs[key];
        },
        getEnv: () => ({
            APPTEK_API_ENDPOINT: 'https://api.mock-apptek.com',
            APPTEK_API_KEY: 'mock-api-key'
        }),
        models: {
            'apptek-translate': mockModel
        }
    };
    
    // Create a fresh copy of the pathway
    t.context.pathway = {
        name: 'translate_apptek',
        model: 'apptek-translate',
        prompt: '{{{text}}}',
        inputParameters: {
            from: 'auto',
            to: 'en',
        }
    };
    
    // Setup basic arguments
    t.context.args = {
        text: 'Hello, how are you?',
        from: 'en',
        to: 'es'
    };

    // Create resolver instance
    t.context.resolver = new PathwayResolver({
        config: t.context.mockConfig,
        pathway: t.context.pathway,
        args: t.context.args,
        endpoints: {
            "apptek-translate": {
                resolve: t.context.sandbox.stub().resolves('translated text'),
                type: 'APPTEK-TRANSLATE'
            }
        }
    });
});

test.afterEach.always((t) => {
    // Restore sandbox
    t.context.sandbox.restore();
});

test('pathway has correct basic configuration', (t) => {
    const pathway = t.context.pathway;
    
    t.is(pathway.model, 'apptek-translate');
    t.is(typeof pathway.prompt, 'string');
});

test('pathway has correct input parameters', (t) => {
    const pathway = t.context.pathway;
    
    t.is(pathway.inputParameters.from, 'auto');
    t.is(pathway.inputParameters.to, 'en');
});


test('resolver processes text correctly', async (t) => {
    const resolver = t.context.resolver;
    const result = await resolver.processInputText('Hello, how are you?');
    t.deepEqual(result, ['Hello, how are you?']);
});

test('resolver handles empty text', async (t) => {
    const resolver = t.context.resolver;
    const result = await resolver.processInputText('');
    t.deepEqual(result, ['']);
});

test('resolver uses correct model', (t) => {
    const resolver = t.context.resolver;
    const model = resolver.model;
    t.is(model.type, 'APPTEK-TRANSLATE');
});
