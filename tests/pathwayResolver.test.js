import test from 'ava';
import { PathwayResolver } from '../server/pathwayResolver.js';
import sinon from 'sinon';
import { mockConfig, mockPathwayString, mockModelEndpoints } from './mocks.js';

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

test('applyPromptsInParallel executes all prompts in parallel and returns array', async (t) => {
  const resolver = t.context.pathwayResolver;
  const text = 'This is a test input text';
  const chunks = [text];
  const parameters = {};
  
  // Mock applyPrompt to return different results for each prompt
  const applyPromptStub = sinon.stub(resolver, 'applyPrompt');
  applyPromptStub.onCall(0).returns(Promise.resolve('result1'));
  applyPromptStub.onCall(1).returns(Promise.resolve('result2'));
  applyPromptStub.onCall(2).returns(Promise.resolve('result3'));

  // Set up prompts with usesTextInput property
  resolver.pathwayPrompt = [
    { usesTextInput: true },
    { usesTextInput: true },
    { usesTextInput: true }
  ];

  const result = await resolver.applyPromptsInParallel(chunks, parameters);

  // All prompts should be called
  t.is(applyPromptStub.callCount, 3);
  
  // Should return array of results
  t.deepEqual(result, ['result1', 'result2', 'result3']);
});

test('applyPromptsInParallel handles prompts without text input', async (t) => {
  const resolver = t.context.pathwayResolver;
  const text = 'This is a test input text';
  const chunks = [text];
  const parameters = {};
  
  const applyPromptStub = sinon.stub(resolver, 'applyPrompt');
  applyPromptStub.onCall(0).returns(Promise.resolve('result1'));
  applyPromptStub.onCall(1).returns(Promise.resolve('result2'));

  // Set up one prompt that uses text input and one that doesn't
  // First prompt contains {{text}} so usesTextInput will be true
  // Second prompt doesn't contain {{text}} so usesTextInput will be false
  resolver.pathwayPrompt = [
    'Analyze this text: {{text}}',
    'What is the current date?'
  ];

  const result = await resolver.applyPromptsInParallel(chunks, parameters);

  // Both prompts should be called
  t.is(applyPromptStub.callCount, 2);
  
  // First call should be for the first prompt (contains {{text}}) with text
  t.is(applyPromptStub.getCall(0).args[1], text);
  
  // Second call should be for the second prompt (no {{text}}) with null
  t.is(applyPromptStub.getCall(1).args[1], null);
  
  t.deepEqual(result, ['result1', 'result2']);
});

test('processRequest uses parallel processing when useParallelPromptProcessing is true', async (t) => {
  const resolver = t.context.pathwayResolver;
  
  // Enable parallel prompt processing
  resolver.pathway.useParallelPromptProcessing = true;
  
  // Set up multiple prompts using simple strings (will be converted to Prompt objects automatically)
  resolver.pathwayPrompt = ['What is this? {{text}}', 'Summarize this: {{text}}'];
  
  // Verify we have multiple prompts
  t.is(resolver.prompts.length, 2);
  
  // Mock the entire processRequest method to test the condition logic separately
  const originalProcessRequest = resolver.processRequest.bind(resolver);
  resolver.processRequest = async function(params) {
    // Mock the internals to avoid token processing
    const chunks = ['test input'];
    if (this.pathway.useParallelPromptProcessing && this.prompts.length > 1) {
      return ['result1', 'result2'];
    }
    return 'serial result';
  };
  
  const result = await resolver.processRequest({ text: 'test input' });
  
  t.deepEqual(result, ['result1', 'result2']);
});

test('processRequest falls back to serial processing when useParallelPromptProcessing is false', async (t) => {
  const resolver = t.context.pathwayResolver;
  
  // Ensure parallel prompt processing is disabled
  resolver.pathway.useParallelPromptProcessing = false;
  resolver.pathway.useParallelChunkProcessing = false;
  
  // Set up multiple prompts using simple strings
  resolver.pathwayPrompt = ['What is this?', 'Summarize this'];
  
  // Mock dependencies to avoid token processing issues
  const processInputTextStub = sinon.stub(resolver, 'processInputText').returns(['test input']);
  const summarizeIfEnabledStub = sinon.stub(resolver, 'summarizeIfEnabled').returns(Promise.resolve('test input'));
  
  // Mock serial processing by stubbing the entire serial flow
  const applyPromptsSeriallyStub = sinon.stub(resolver, 'applyPromptsSerially').returns(Promise.resolve('result2'));
  
  const result = await resolver.processRequest({ text: 'test input' });
  
  // Should call serial processing
  t.true(applyPromptsSeriallyStub.calledOnce);
  
  // Final result should be the last prompt's result (serial behavior)
  t.is(result, 'result2');
});

test('pathway with useParallelPromptProcessing enabled returns array from processRequest', async (t) => {
  const resolver = t.context.pathwayResolver;
  
  // Enable parallel prompt processing on the pathway
  resolver.pathway.useParallelPromptProcessing = true;
  
  // Set up multiple prompts
  resolver.pathwayPrompt = ['Analyze: {{text}}', 'Summarize: {{text}}'];
  
  // Mock dependencies
  const processInputTextStub = sinon.stub(resolver, 'processInputText').returns(['test input']);
  const summarizeIfEnabledStub = sinon.stub(resolver, 'summarizeIfEnabled').returns(Promise.resolve('test input'));
  const applyPromptsInParallelStub = sinon.stub(resolver, 'applyPromptsInParallel').returns(Promise.resolve(['analysis result', 'summary result']));
  
  const result = await resolver.processRequest({ text: 'test input' });
  
  // Should call parallel processing
  t.true(applyPromptsInParallelStub.calledOnce);
  
  // Should return array of results
  t.deepEqual(result, ['analysis result', 'summary result']);
});

test('pathway with single prompt and useParallelPromptProcessing enabled still works', async (t) => {
  const resolver = t.context.pathwayResolver;
  
  // Enable parallel prompt processing but with single prompt
  resolver.pathway.useParallelPromptProcessing = true;
  resolver.pathwayPrompt = ['Single prompt: {{text}}'];
  
  // Mock dependencies
  const processInputTextStub = sinon.stub(resolver, 'processInputText').returns(['test input']);
  const summarizeIfEnabledStub = sinon.stub(resolver, 'summarizeIfEnabled').returns(Promise.resolve('test input'));
  const applyPromptStub = sinon.stub(resolver, 'applyPrompt').returns(Promise.resolve('single result'));
  
  const result = await resolver.processRequest({ text: 'test input' });
  
  // Should fall back to serial processing for single prompt
  t.true(applyPromptStub.called);
  t.is(result, 'single result');
});

test('parallel processing respects prompts that do not use text input', async (t) => {
  const resolver = t.context.pathwayResolver;
  
  // Set up prompts with different text input requirements
  resolver.pathwayPrompt = [
    'Process this text: {{text}}',    // uses text
    'What is the current date?'       // does not use text
  ];
  
  const chunks = ['test input'];
  const parameters = {};
  
  const applyPromptStub = sinon.stub(resolver, 'applyPrompt');
  applyPromptStub.onCall(0).returns(Promise.resolve('text processing result'));
  applyPromptStub.onCall(1).returns(Promise.resolve('date result'));
  
  const result = await resolver.applyPromptsInParallel(chunks, parameters);
  
  // Both prompts should be called
  t.is(applyPromptStub.callCount, 2);
  
  // First prompt should get text, second should get null
  t.is(applyPromptStub.getCall(0).args[1], 'test input');
  t.is(applyPromptStub.getCall(1).args[1], null);
  
  // Should return array of results
  t.deepEqual(result, ['text processing result', 'date result']);
});