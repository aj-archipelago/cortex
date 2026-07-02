import test from 'ava';
import sinon from 'sinon';
import { config } from '../../../config.js';
import { resolveModelName, modelEndpoints, buildModelEndpoints } from '../../../lib/requestExecutor.js';
import { PathwayResolver } from '../../../server/pathwayResolver.js';

let configStub;

test.beforeEach(() => {
    configStub = sinon.stub(config, 'get');
    configStub.callThrough();
});

test.afterEach.always(() => {
    configStub.restore();
    delete modelEndpoints['group-model'];
});

test.serial('default Sonnet Vertex endpoint routes to Sonnet deployment', (t) => {
    const models = config.get('models');
    const sonnetUrl = models['claude-46-sonnet-vertex'].endpoints[0].url;

    t.true(sonnetUrl.endsWith('/claude-sonnet-4-6'));
    t.false(sonnetUrl.includes('claude-opus-4-7'));
});

// ---------------------------------------------------------------------------
// resolveModelName
// ---------------------------------------------------------------------------

test.serial('resolveModelName returns the same name when no redirects configured', (t) => {
    configStub.withArgs('modelRedirects').returns({});
    t.is(resolveModelName('oai-gpt4o'), 'oai-gpt4o');
});

test.serial('resolveModelName returns the same name when name is not in redirect map', (t) => {
    configStub.withArgs('modelRedirects').returns({ 'old-model': 'new-model' });
    t.is(resolveModelName('oai-gpt4o'), 'oai-gpt4o');
});

test.serial('resolveModelName follows a single redirect', (t) => {
    configStub.withArgs('modelRedirects').returns({
        'claude-35-sonnet-vertex': 'claude-46-sonnet-vertex',
    });
    t.is(resolveModelName('claude-35-sonnet-vertex'), 'claude-46-sonnet-vertex');
});

test.serial('resolveModelName follows transitive redirects', (t) => {
    configStub.withArgs('modelRedirects').returns({
        'model-v1': 'model-v2',
        'model-v2': 'model-v3',
    });
    t.is(resolveModelName('model-v1'), 'model-v3');
});

test.serial('resolveModelName handles circular redirects without infinite loop', (t) => {
    configStub.withArgs('modelRedirects').returns({
        'model-a': 'model-b',
        'model-b': 'model-a',
    });
    const result = resolveModelName('model-a');
    t.true(result === 'model-a' || result === 'model-b');
});

test.serial('resolveModelName handles null/undefined modelRedirects gracefully', (t) => {
    configStub.withArgs('modelRedirects').returns(null);
    t.is(resolveModelName('any-model'), 'any-model');
});

// ---------------------------------------------------------------------------
// buildModelEndpoints — redirect aliasing
// ---------------------------------------------------------------------------

test.serial('buildModelEndpoints creates alias entries for redirected models', (t) => {
    const mockModels = {
        'claude-46-sonnet-vertex': {
            type: 'CLAUDE-4-VERTEX',
            endpoints: [{ name: 'ep1', url: 'https://example.com', headers: {}, requestsPerSecond: 10 }],
            maxTokenLength: 200000,
        },
        'oai-gpt4o': {
            type: 'OPENAI-CHAT',
            endpoints: [{ name: 'ep2', url: 'https://example.com', headers: {}, requestsPerSecond: 10 }],
            maxTokenLength: 128000,
        },
    };

    const fakeConfig = {
        get: (key) => {
            if (key === 'models') return JSON.parse(JSON.stringify(mockModels));
            if (key === 'modelRedirects') return { 'claude-35-sonnet-vertex': 'claude-46-sonnet-vertex' };
            return config.get(key);
        },
    };

    buildModelEndpoints(fakeConfig);

    t.truthy(modelEndpoints['claude-35-sonnet-vertex'], 'alias entry should exist');
    t.is(modelEndpoints['claude-35-sonnet-vertex'], modelEndpoints['claude-46-sonnet-vertex'],
        'alias should point to the same object as the target');
});

test.serial('buildModelEndpoints skips redirect when target model does not exist', (t) => {
    const mockModels = {
        'oai-gpt4o': {
            type: 'OPENAI-CHAT',
            endpoints: [{ name: 'ep1', url: 'https://example.com', headers: {}, requestsPerSecond: 10 }],
            maxTokenLength: 128000,
        },
    };

    const fakeConfig = {
        get: (key) => {
            if (key === 'models') return JSON.parse(JSON.stringify(mockModels));
            if (key === 'modelRedirects') return { 'old-model': 'nonexistent-model' };
            return config.get(key);
        },
    };

    buildModelEndpoints(fakeConfig);

    t.falsy(modelEndpoints['old-model'], 'alias should not be created for missing target');
});

test.serial('buildModelEndpoints handles multiple redirects', (t) => {
    const mockModels = {
        'claude-45-haiku-vertex': {
            type: 'CLAUDE-4-VERTEX',
            endpoints: [{ name: 'ep1', url: 'https://example.com', headers: {}, requestsPerSecond: 10 }],
            maxTokenLength: 200000,
        },
        'claude-46-sonnet-vertex': {
            type: 'CLAUDE-4-VERTEX',
            endpoints: [{ name: 'ep2', url: 'https://example.com', headers: {}, requestsPerSecond: 10 }],
            maxTokenLength: 200000,
        },
        'claude-48-opus-vertex': {
            type: 'CLAUDE-4-VERTEX',
            endpoints: [{ name: 'ep3', url: 'https://example.com', headers: {}, requestsPerSecond: 10 }],
            maxTokenLength: 1000000,
        },
    };

    const fakeConfig = {
        get: (key) => {
            if (key === 'models') return JSON.parse(JSON.stringify(mockModels));
            if (key === 'modelRedirects') return {
                'claude-3-haiku-vertex': 'claude-45-haiku-vertex',
                'claude-37-sonnet-vertex': 'claude-46-sonnet-vertex',
                'claude-46-opus-vertex': 'claude-48-opus-vertex',
                'claude-47-opus-vertex': 'claude-48-opus-vertex',
            };
            return config.get(key);
        },
    };

    buildModelEndpoints(fakeConfig);

    t.is(modelEndpoints['claude-3-haiku-vertex'], modelEndpoints['claude-45-haiku-vertex']);
    t.is(modelEndpoints['claude-37-sonnet-vertex'], modelEndpoints['claude-46-sonnet-vertex']);
    t.is(modelEndpoints['claude-46-opus-vertex'], modelEndpoints['claude-48-opus-vertex']);
    t.is(modelEndpoints['claude-47-opus-vertex'], modelEndpoints['claude-48-opus-vertex']);
});

// ---------------------------------------------------------------------------
// PathwayResolver — constructor resolves redirected model names
// ---------------------------------------------------------------------------

test.serial('PathwayResolver constructor resolves a redirected model name', (t) => {
    const endpoints = {
        'new-model': { name: 'new-model', type: 'OPENAI-CHAT', url: 'https://example.com' },
    };

    configStub.withArgs('modelRedirects').returns({ 'old-model': 'new-model' });
    configStub.withArgs('defaultModelName').returns('new-model');

    const resolver = new PathwayResolver({
        config,
        pathway: { model: 'old-model', prompt: 'test' },
        args: { text: 'hello' },
        endpoints,
    });

    t.is(resolver.modelName, 'new-model');
    t.is(resolver.model, endpoints['new-model']);
});

test.serial('PathwayResolver constructor does not warn when a modelGroup alias resolves to a valid model', (t) => {
    const endpoints = {
        'group-model': { name: 'group-model', type: 'OPENAI-CHAT', url: 'https://example.com' },
    };
    modelEndpoints['group-model'] = {
        endpoints: [{
            name: 'group-model-ep',
            monitor: {
                healthy: true,
                getAverageTTFB: () => 0,
            },
        }],
    };

    configStub.withArgs('modelRedirects').returns({});
    configStub.withArgs('modelGroups').returns({
        'group-alias': { members: ['group-model'] },
    });
    configStub.withArgs('defaultModelName').returns('group-model');

    const resolver = new PathwayResolver({
        config,
        pathway: { model: 'group-alias', prompt: 'test' },
        args: { text: 'hello' },
        endpoints,
    });

    t.is(resolver.modelName, 'group-model');
    t.deepEqual(resolver.warnings, []);
});

test.serial('PathwayResolver constructor falls through to args.model after redirect', (t) => {
    const endpoints = {
        'target-model': { name: 'target-model', type: 'OPENAI-CHAT', url: 'https://example.com' },
    };

    configStub.withArgs('modelRedirects').returns({
        'deprecated-model': 'target-model',
    });
    configStub.withArgs('defaultModelName').returns('target-model');

    const resolver = new PathwayResolver({
        config,
        pathway: { prompt: 'test' },
        args: { text: 'hello', model: 'deprecated-model' },
        endpoints,
    });

    t.is(resolver.modelName, 'target-model');
});

test.serial('PathwayResolver constructor uses defaultModelName redirect', (t) => {
    const endpoints = {
        'final-model': { name: 'final-model', type: 'OPENAI-CHAT', url: 'https://example.com' },
    };

    configStub.withArgs('modelRedirects').returns({
        'default-old': 'final-model',
    });
    configStub.withArgs('defaultModelName').returns('default-old');

    const resolver = new PathwayResolver({
        config,
        pathway: { prompt: 'test' },
        args: { text: 'hello' },
        endpoints,
    });

    t.is(resolver.modelName, 'final-model');
});

test.serial('PathwayResolver constructor works normally when no redirect matches', (t) => {
    const endpoints = {
        'regular-model': { name: 'regular-model', type: 'OPENAI-CHAT', url: 'https://example.com' },
    };

    configStub.withArgs('modelRedirects').returns({ 'some-other': 'elsewhere' });
    configStub.withArgs('defaultModelName').returns('regular-model');

    const resolver = new PathwayResolver({
        config,
        pathway: { model: 'regular-model', prompt: 'test' },
        args: { text: 'hello' },
        endpoints,
    });

    t.is(resolver.modelName, 'regular-model');
});

// ---------------------------------------------------------------------------
// PathwayResolver.swapModel — resolves redirected names
// ---------------------------------------------------------------------------

test.serial('swapModel resolves a redirected model name', (t) => {
    const endpoints = {
        'current-model': { name: 'current-model', type: 'OPENAI-CHAT', url: 'https://example.com' },
        'target-model': { name: 'target-model', type: 'OPENAI-CHAT', url: 'https://example.com' },
    };

    configStub.withArgs('modelRedirects').returns({ 'old-model': 'target-model' });
    configStub.withArgs('defaultModelName').returns('current-model');

    const resolver = new PathwayResolver({
        config,
        pathway: { model: 'current-model', prompt: 'test' },
        args: { text: 'hello' },
        endpoints,
    });

    sinon.stub(resolver, 'getChunkMaxTokenLength').returns(1000);
    resolver.swapModel('old-model');

    t.is(resolver.modelName, 'target-model');
    t.is(resolver.model, endpoints['target-model']);
});

test.serial('swapModel throws for model that does not resolve to a valid endpoint', (t) => {
    const endpoints = {
        'current-model': { name: 'current-model', type: 'OPENAI-CHAT', url: 'https://example.com' },
    };

    configStub.withArgs('modelRedirects').returns({});
    configStub.withArgs('defaultModelName').returns('current-model');

    const resolver = new PathwayResolver({
        config,
        pathway: { model: 'current-model', prompt: 'test' },
        args: { text: 'hello' },
        endpoints,
    });

    t.throws(() => resolver.swapModel('nonexistent-model'), {
        message: /nonexistent-model not found in config/,
    });
});
