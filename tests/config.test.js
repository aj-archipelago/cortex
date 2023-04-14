// config.test.js

import test from 'ava';
import path from 'path';
import { config, buildPathways, buildModels } from '../config.js';

test.before(async () => {
    await buildPathways(config);
    buildModels(config);
});

test('config pathwaysPath', (t) => {
    const expectedDefault = path.join(process.cwd(), '/pathways');
    t.is(config.get('pathwaysPath'), expectedDefault);
});

test('config corePathwaysPath', (t) => {
    const expectedPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'pathways');
    t.is(config.get('corePathwaysPath'), expectedPath);
});

test('config basePathwayPath', (t) => {
    const expectedPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'pathways', 'basePathway.js');
    t.is(config.get('basePathwayPath'), expectedPath);
});

test('config PORT', (t) => {
    const expectedDefault = 4000;
    t.is(config.get('PORT'), expectedDefault);
});

test('config enableCache', (t) => {
    const expectedDefault = true;
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
    const expectedDefault = 'text-davinci-003';
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