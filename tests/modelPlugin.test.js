// test/ModelPlugin.test.js
import test from 'ava';
import ModelPlugin from '../server/plugins/modelPlugin.js';
import HandleBars from '../lib/handleBars.js';
import { mockConfig, mockPathwayString, mockPathwayFunction, mockPathwayMessages, mockPathwayResolverString } from './mocks.js';

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_PROMPT_TOKEN_RATIO = 0.5;

// Mock configuration and pathway objects
const { config, pathway, modelName, model } = mockPathwayResolverString;

test('ModelPlugin constructor', (t) => {
    const modelPlugin = new ModelPlugin(config, pathway, modelName, model);

    t.is(modelPlugin.modelName, pathway.model, 'modelName should be set from pathway');
    t.deepEqual(modelPlugin.model, config.get('models')[pathway.model], 'model should be set from config');
    t.is(modelPlugin.temperature, pathway.temperature, 'temperature should be set from pathway');
    t.is(modelPlugin.pathwayPrompt, pathway.prompt, 'pathwayPrompt should be set from pathway');
});

test.beforeEach((t) => {
  t.context.modelPlugin = new ModelPlugin(config, pathway, modelName, model);
});

test('getCompiledPrompt - text and parameters', (t) => {
  const { modelPlugin } = t.context;
  const text = 'Hello, World!';
  const parameters = { name: 'John', age: 30 };

  const { modelPromptText, tokenLength } = modelPlugin.getCompiledPrompt(text, parameters, pathway.prompt);

  t.true(modelPromptText.includes(text));
  t.true(modelPromptText.includes(parameters.name));
  t.true(modelPromptText.includes(parameters.age.toString()));
  t.is(typeof tokenLength, 'number');
});

test('getCompiledPrompt - custom prompt function', (t) => {
  const { modelPlugin } = t.context;
  const text = 'Hello, World!';
  const parameters = { name: 'John', age: 30 };

  const { modelPromptText, tokenLength } = modelPlugin.getCompiledPrompt(text, parameters, mockPathwayFunction.prompt);

  t.true(modelPromptText.includes(text));
  t.true(modelPromptText.includes(parameters.name));
  t.true(modelPromptText.includes(parameters.age.toString()));
  t.is(typeof tokenLength, 'number');
});

test('getCompiledPrompt - model prompt messages', (t) => {
  const { modelPlugin } = t.context;
  const text = 'Translate the following text to French: "Hello, World!"';
  const parameters = {}

  const { modelPromptMessages, tokenLength } = modelPlugin.getCompiledPrompt(text, parameters, mockPathwayMessages.prompt);

  t.true(modelPromptMessages[0].content.includes(text));
  t.true(modelPromptMessages[1].content.includes(text));
  t.is(typeof tokenLength, 'number');
});

test('getModelMaxTokenLength', (t) => {
    const { modelPlugin } = t.context;
    t.is(modelPlugin.getModelMaxTokenLength(), DEFAULT_MAX_TOKENS, 'getModelMaxTokenLength should return default max tokens');
});

test('getPromptTokenRatio', (t) => {
    const { modelPlugin } = t.context;
    t.is(modelPlugin.getPromptTokenRatio(), DEFAULT_PROMPT_TOKEN_RATIO, 'getPromptTokenRatio should return default prompt token ratio');
});

test('requestUrl', (t) => {
    const { modelPlugin } = t.context;

    const expectedUrl = HandleBars.compile(modelPlugin.model.url)({ ...modelPlugin.model, ...config.getEnv(), ...config });
    t.is(modelPlugin.requestUrl(), expectedUrl, 'requestUrl should return the correct URL');
});

test('default parseResponse', (t) => {
    const { modelPlugin } = t.context;
    const multipleChoicesResponse = {
        choices: [
            { text: '42' },
            { text: 'life' }
        ]
    };

    const result = modelPlugin.parseResponse(multipleChoicesResponse);
    t.deepEqual(result, multipleChoicesResponse, 'default parseResponse should return the entire multiple choices response object');
});

test('truncateMessagesToTargetLength', (t) => {
    const { modelPlugin } = t.context;
    const messages = [
        { role: 'user', content: 'What is the meaning of life?' },
        { role: 'assistant', content: 'The meaning of life is a philosophical question regarding the purpose and significance of life or existence in general.' }
    ];
    const targetTokenLength = 25;

    const result = modelPlugin.truncateMessagesToTargetLength(messages, targetTokenLength);
    t.true(Array.isArray(result), 'truncateMessagesToTargetLength should return an array');
    t.true(result.length <= messages.length, 'truncateMessagesToTargetLength should not return more messages than the input');
});

test('messagesToChatML', (t) => {
    const { modelPlugin } = t.context;
    const messages = [
        { role: 'user', content: 'What is the meaning of life?' },
        { role: 'assistant', content: 'The meaning of life is a philosophical question regarding the purpose and significance of life or existence in general.' }
    ];

    const result = modelPlugin.messagesToChatML(messages);
    t.is(typeof result, 'string', 'messagesToChatML should return a string');
});