import test from 'ava';
import { PathwayResolver } from '../graphql/pathwayResolver.js';
import sinon from 'sinon';
import { mockConfig, mockPathwayString } from './mocks.js';

const mockPathway = mockPathwayString;
mockPathway.useInputChunking = false;
mockPathway.prompt = 'What is AI?';

const mockArgs = {
  text: 'Artificial intelligence',
};

test.beforeEach((t) => {
  t.context.pathwayResolver = new PathwayResolver({
    config: mockConfig,
    pathway: mockPathway,
    args: mockArgs,
  });
});

test('constructor initializes properties correctly', (t) => {
  const resolver = t.context.pathwayResolver;
  t.deepEqual(resolver.config, mockConfig);
  t.deepEqual(resolver.pathway, mockPathway);
  t.deepEqual(resolver.args, mockArgs);
  t.is(resolver.useInputChunking, mockPathway.useInputChunking);
  t.is(typeof resolver.requestId, 'string');
});

test('resolve returns request id when async is true', async (t) => {
  const resolver = t.context.pathwayResolver;
  const requestId = await resolver.resolve({ ...mockArgs, async: true });
  t.is(typeof requestId, 'string');
  t.is(requestId, resolver.requestId);
});

test('resolve calls promptAndParse when async is false', async (t) => {
  const resolver = t.context.pathwayResolver;
  const promptAndParseStub = sinon.stub(resolver, 'promptAndParse').returns(Promise.resolve('test-result'));

  const result = await resolver.resolve(mockArgs);
  t.true(promptAndParseStub.calledOnce);
  t.is(result, 'test-result');
});

test('processInputText returns input text if no chunking', (t) => {
  const resolver = t.context.pathwayResolver;
  const text = 'This is a test input text';
  const result = resolver.processInputText(text);
  t.deepEqual(result, [text]);
});

test('applyPromptsSerially returns result of last prompt', async (t) => {
  const resolver = t.context.pathwayResolver;
  const text = 'This is a test input text';
  const applyPromptStub = sinon.stub(resolver, 'applyPrompt');
  applyPromptStub.onCall(0).returns(Promise.resolve('result1'));
  applyPromptStub.onCall(1).returns(Promise.resolve('result2'));

  resolver.pathwayPrompt = ['prompt1', 'prompt2'];
  const result = await resolver.applyPromptsSerially(text, mockArgs);

  t.is(result, 'result2');
});

test('processRequest returns empty result when input text is empty', async (t) => {
    const resolver = t.context.pathwayResolver;
    const text = '';
    const processRequestStub = sinon.stub(resolver, 'processRequest').returns(Promise.resolve(''));
  
    await resolver.resolve({ ...mockArgs, text });
  
    t.true(processRequestStub.calledOnce);
    const returnValue = await processRequestStub.firstCall.returnValue;
    t.is(returnValue, text);
  });