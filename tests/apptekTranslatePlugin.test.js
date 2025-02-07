import test from 'ava';
import sinon from 'sinon';
import ApptekTranslatePlugin from '../server/plugins/apptekTranslatePlugin.js';
import { config } from '../config.js';

// Mock pathway and model
const mockPathway = {
    inputParameters: {
        from: 'auto',
        to: 'es',
        tokenRatio: 0.2
    }
};

const mockModel = {
    name: 'apptek-translate',
    type: 'APPTEK-TRANSLATE',
    requestsPerSecond: 10,
    maxTokenLength: 2000,
    apiEndpoint: 'https://api.mock-apptek.com'
};

// Mock environment variables
const mockEnv = {
    APPTEK_API_ENDPOINT: 'https://api.mock-apptek.com',
    APPTEK_API_KEY: 'mock-api-key'
};

test.beforeEach((t) => {
    // Create a sinon sandbox
    t.context.sandbox = sinon.createSandbox();
    
    // Create mock config
    t.context.mockConfig = {
        get: (key) => {
            const configs = {
                models: {
                    'apptek-translate': mockModel
                }
            };
            return configs[key];
        },
        getEnv: () => mockEnv
    };
    
    // Setup fetch mock
    global.fetch = t.context.sandbox.stub();
    
    // Create plugin instance with mock config
    t.context.plugin = new ApptekTranslatePlugin(mockPathway, mockModel, t.context.mockConfig);
});

test.afterEach.always((t) => {
    // Restore sandbox
    t.context.sandbox.restore();
});

test('constructor initializes with correct configuration', (t) => {
    const plugin = t.context.plugin;
    t.is(plugin.apiEndpoint, mockEnv.APPTEK_API_ENDPOINT);
    t.is(plugin.apiKey, mockEnv.APPTEK_API_KEY);
    t.deepEqual(plugin.config, t.context.mockConfig);
    t.is(plugin.pathwayPrompt, mockPathway.prompt);
    t.is(plugin.modelName, mockModel.name);
});

test('getRequestParameters returns correct parameters', async (t) => {
    const plugin = t.context.plugin;
    const text = 'Hello, how are you?';
    const parameters = { from: 'en', to: 'es' };
    const prompt = mockPathway.prompt;

    const result = await plugin.getRequestParameters(text, parameters, prompt);
    t.deepEqual(result, {
        data: 'Hello, how are you?',
        params: {
            from: 'en',
            to: 'es'
        }
    });
});

test('detectLanguage successfully detects language', async (t) => {
    const plugin = t.context.plugin;
    const text = 'Hello, how are you?';
    
    // Mock successful language detection
    global.fetch
        .withArgs(sinon.match(/api\/v2\/language_id$/))
        .resolves({
            ok: true,
            status: 200,
            json: async () => ({ success: true, request_id: 'mock-id' })
        });
    
    global.fetch
        .withArgs(sinon.match(/api\/v2\/language_id\/mock-id$/))
        .resolves({
            ok: true,
            status: 200,
            text: async () => 'en;0.99'
        });
    
    const detectedLang = await plugin.detectLanguage(text);
    t.is(detectedLang, 'en');
});

test('detectLanguage handles API errors', async (t) => {
    const plugin = t.context.plugin;
    const text = 'Hello, how are you?';
    
    // Mock API error
    global.fetch
        .withArgs(sinon.match(/api\/v2\/language_id$/))
        .resolves({
            ok: false,
            status: 500
        });
    
    await t.throwsAsync(async () => {
        await plugin.detectLanguage(text);
    }, {
        message: /Language detection failed: 500/
    });
});

test('execute successfully translates text', async (t) => {
    const plugin = t.context.plugin;
    const text = 'Hello, how are you?';
    const parameters = { from: 'en', to: 'es' };
    const prompt = mockPathway.prompt;
    const cortexRequest = {};
    
    // Mock successful translation
    global.fetch
        .withArgs(sinon.match(/api\/v1\/quicktranslate\/en-es$/))
        .resolves({
            ok: true,
            status: 200,
            text: async () => 'Hola, ¿cómo estás?'
        });
    
    const result = await plugin.execute(text, parameters, prompt, cortexRequest);
    t.is(result, 'Hola, ¿cómo estás?');
});

test('execute with auto language detection', async (t) => {
    const plugin = t.context.plugin;
    const text = 'Hello, how are you?';
    const parameters = { from: 'auto', to: 'es' };
    const prompt = mockPathway.prompt;
    const cortexRequest = {};
    
    // Mock language detection
    global.fetch
        .withArgs(sinon.match(/api\/v2\/language_id$/))
        .resolves({
            ok: true,
            status: 200,
            json: async () => ({ success: true, request_id: 'mock-id' })
        });
    
    global.fetch
        .withArgs(sinon.match(/api\/v2\/language_id\/mock-id$/))
        .resolves({
            ok: true,
            status: 200,
            text: async () => 'en;0.99'
        });
    
    // Mock translation
    global.fetch
        .withArgs(sinon.match(/api\/v1\/quicktranslate\/en-es$/))
        .resolves({
            ok: true,
            status: 200,
            text: async () => 'Hola, ¿cómo estás?'
        });
    
    const result = await plugin.execute(text, parameters, prompt, cortexRequest);
    t.is(result, 'Hola, ¿cómo estás?');
});

test('parseResponse trims response text', (t) => {
    const plugin = t.context.plugin;
    const response = '  translated text  ';
    t.is(plugin.parseResponse(response), 'translated text');
});
