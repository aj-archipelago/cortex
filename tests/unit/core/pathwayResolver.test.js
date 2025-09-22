import test from 'ava';
import { PathwayResolver } from '../../../server/pathwayResolver.js';
import sinon from 'sinon';
import { mockConfig, mockPathwayString, mockModelEndpoints } from '../../helpers/mocks.js';

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
    endpoints: mockModelEndpoints,
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

test('swapModel successfully changes model', (t) => {
  const resolver = t.context.pathwayResolver;
  const originalModelName = resolver.modelName;
  const originalModel = resolver.model;
  const originalModelExecutor = resolver.modelExecutor;
  
  // Mock the getChunkMaxTokenLength method to avoid complex calculations
  const getChunkMaxTokenLengthStub = sinon.stub(resolver, 'getChunkMaxTokenLength').returns(1000);
  
  // Find a different model name from the mock endpoints
  const availableModels = Object.keys(mockModelEndpoints);
  const newModelName = availableModels.find(name => name !== originalModelName) || availableModels[0];
  
  resolver.swapModel(newModelName);
  
  t.not(resolver.modelName, originalModelName);
  t.is(resolver.modelName, newModelName);
  t.not(resolver.model, originalModel);
  t.is(resolver.model, mockModelEndpoints[newModelName]);
  t.not(resolver.modelExecutor, originalModelExecutor);
  t.true(getChunkMaxTokenLengthStub.calledOnce);
  
  getChunkMaxTokenLengthStub.restore();
});

test('swapModel throws error for non-existent model', (t) => {
  const resolver = t.context.pathwayResolver;
  
  t.throws(() => {
    resolver.swapModel('non-existent-model');
  }, { message: 'Model non-existent-model not found in config' });
});

test('swapModel logs warning about model change', (t) => {
  const resolver = t.context.pathwayResolver;
  const logWarningStub = sinon.stub(resolver, 'logWarning');
  
  // Find a different model name from the mock endpoints
  const availableModels = Object.keys(mockModelEndpoints);
  const newModelName = availableModels.find(name => name !== resolver.modelName) || availableModels[0];
  
  resolver.swapModel(newModelName);
  
  t.true(logWarningStub.calledWith(`Model swapped to ${newModelName}`));
  
  logWarningStub.restore();
});

test('promptAndParse swaps model when model is specified in args', async (t) => {
  const resolver = t.context.pathwayResolver;
  const swapModelStub = sinon.stub(resolver, 'swapModel');
  const processRequestStub = sinon.stub(resolver, 'processRequest').returns(Promise.resolve('test result'));
  
  // Mock the response parser to return the result directly
  const parseStub = sinon.stub(resolver.responseParser, 'parse').returns(Promise.resolve('test result'));
  
  const argsWithModel = { ...mockArgs, modelOverride: 'anotherModel' };
  
  await resolver.promptAndParse(argsWithModel);
  
  t.true(swapModelStub.calledWith('anotherModel'));
  
  swapModelStub.restore();
  processRequestStub.restore();
  parseStub.restore();
});

test('promptAndParse does not swap model when model is same as current', async (t) => {
  const resolver = t.context.pathwayResolver;
  const swapModelStub = sinon.stub(resolver, 'swapModel');
  const processRequestStub = sinon.stub(resolver, 'processRequest').returns(Promise.resolve('test result'));
  
  // Mock the response parser to return the result directly
  const parseStub = sinon.stub(resolver.responseParser, 'parse').returns(Promise.resolve('test result'));
  
  const argsWithSameModel = { ...mockArgs, model: resolver.modelName };
  
  await resolver.promptAndParse(argsWithSameModel);
  
  t.false(swapModelStub.called);
  
  swapModelStub.restore();
  processRequestStub.restore();
  parseStub.restore();
});

test('promptAndParse handles model swap errors gracefully', async (t) => {
  const resolver = t.context.pathwayResolver;
  const logErrorStub = sinon.stub(resolver, 'logError');
  const processRequestStub = sinon.stub(resolver, 'processRequest').returns(Promise.resolve('test result'));
  
  // Mock the response parser to return the result directly
  const parseStub = sinon.stub(resolver.responseParser, 'parse').returns(Promise.resolve('test result'));
  
  // Mock swapModel to throw an error
  const swapModelStub = sinon.stub(resolver, 'swapModel').throws(new Error('Model not found'));
  
  const argsWithInvalidModel = { ...mockArgs, modelOverride: 'invalidModel' };
  
  await resolver.promptAndParse(argsWithInvalidModel);
  
  t.true(logErrorStub.calledWith('Failed to swap model to invalidModel: Model not found'));
  
  swapModelStub.restore();
  logErrorStub.restore();
  processRequestStub.restore();
  parseStub.restore();
});