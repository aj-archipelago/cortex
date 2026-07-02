// config.test.js

import test from 'ava';
import path from 'path';
import { config, buildPathways, buildModels } from '../../../config.js';

test.before(async () => {
    process.env.AZURE_COGNITIVE_API_URL_QA = 'https://qa-search.example.test';
    process.env.AZURE_COGNITIVE_API_KEY_QA = 'abc=def&ghi';
    await buildPathways(config);
    buildModels(config);
});

test('config pathwaysPath', (t) => {
    const expectedDefault = path.join(process.cwd(), '/pathways');
    t.is(config.get('pathwaysPath'), expectedDefault);
});

test('config corePathwaysPath', (t) => {
    const expectedPath = path.join(process.cwd(), 'pathways');
    t.is(config.get('corePathwaysPath'), expectedPath);
});

test('config basePathwayPath', (t) => {
    const expectedPath = path.join(process.cwd(), 'pathways', 'basePathway.js');
    t.is(config.get('basePathwayPath'), expectedPath);
});

test('config PORT', (t) => {
    const expectedDefault = parseInt(process.env.CORTEX_PORT) || 4000;
    t.is(config.get('PORT'), expectedDefault);
});

test('config enableCache', (t) => {
    const expectedDefault = false;
    t.is(config.get('enableCache'), expectedDefault);
});

test('config enableGraphqlCache', (t) => {
    const expectedDefault = false;
    t.is(config.get('enableGraphqlCache'), expectedDefault);
});

test('config enableRestEndpoints', (t) => {
    const expectedDefault = false;
    t.is(config.get('enableRestEndpoints'), expectedDefault);
});

test('config openaiDefaultModel', (t) => {
    const expectedDefault = 'gpt-3.5-turbo';
    t.is(config.get('openaiDefaultModel'), expectedDefault);
});

test('config openaiApiUrl', (t) => {
    const expectedDefault = 'https://api.openai.com/v1/completions';
    t.is(config.get('openaiApiUrl'), expectedDefault);
});

test('buildPathways adds pathways to config', (t) => {
    const pathways = config.get('pathways');
    t.true(Object.keys(pathways).length > 0);
});

test('buildModels adds models to config', (t) => {
    const models = config.get('models');
    t.true(Object.keys(models).length > 0);
});

test('buildModels sets defaultModelName if not provided', (t) => {
    t.truthy(config.get('defaultModelName'));
});

test('buildModels resolves model dataSources templates', (t) => {
    const testModelName = 'unit-test-data-sources-template-model';
    const models = config.get('models');

    config.load({
        models: {
            ...models,
            [testModelName]: {
                type: 'OPENAI',
                url: 'https://example.test',
                headers: {},
                dataSources: [
                    {
                        type: 'AzureCognitiveSearch',
                        parameters: {
                            endpoint: '{{{AZURE_COGNITIVE_API_URL_QA}}}',
                            key: '{{{AZURE_COGNITIVE_API_KEY_QA}}}',
                        },
                    },
                ],
            },
        },
    });

    buildModels(config);

    const dataSources = config.get('models')[testModelName].dataSources;
    const serializedDataSources = JSON.stringify(dataSources);

    t.false(serializedDataSources.includes('{{'));
    t.is(dataSources[0].parameters.endpoint, process.env.AZURE_COGNITIVE_API_URL_QA);
    t.is(dataSources[0].parameters.key, process.env.AZURE_COGNITIVE_API_KEY_QA);
});
