import test from 'ava';
import serverFactory from '../index.js';

let testServer;

// List of models to test - comment out models you don't want to test
const modelsToTest = [
  'oai-gpt41-mini',
  'claude-37-sonnet-vertex',
];

// Add timing data structure
const modelTimings = {};

// Helper function to track timing
const trackTiming = (model, startTime) => {
  const duration = Date.now() - startTime;
  if (!modelTimings[model]) {
    modelTimings[model] = [];
  }
  modelTimings[model].push(duration);
};

// Helper function to calculate average timing
const calculateAverageTiming = (timings) => {
  return timings.reduce((a, b) => a + b, 0) / timings.length;
};

// Helper function to print model rankings
const printModelRankings = () => {
  const averageTimings = Object.entries(modelTimings).map(([model, timings]) => ({
    model,
    avgTime: calculateAverageTiming(timings)
  }));
  
  averageTimings.sort((a, b) => a.avgTime - b.avgTime);
  
  console.log('\nModel Performance Rankings:');
  console.log('-------------------------');
  averageTimings.forEach((entry, index) => {
    console.log(`${index + 1}. ${entry.model}: ${Math.round(entry.avgTime)}ms average`);
  });
};

// Modify runTestForModels to run tests sequentially
const runTestForModels = (testName, testFn) => {
  for (const model of modelsToTest) {
    test.serial(`${testName}-${model} (sequential)`, async t => {
      console.log(`\nRunning ${testName} for ${model}...`);
      const startTime = Date.now();

      try {
        await testFn(t, model);
        trackTiming(model, startTime);
        console.log(`✓ ${model} completed in ${Date.now() - startTime}ms`);
      } catch (error) {
        console.log(`✗ ${model} failed after ${Date.now() - startTime}ms`);
        console.error(error);
        throw error; // Re-throw to fail the test
      }
    });
  }
};

test.before(async () => {
  const { server, startServer } = await serverFactory();
  startServer && await startServer();
  testServer = server;
});

test.after.always('cleanup', async () => {
  if (testServer) {
    await testServer.stop();
  }
});

// Add after.always hook to print rankings
test.after.always('print rankings', async () => {
  printModelRankings();
});

// Test basic tool calling with a search request
runTestForModels('call_tools handles search request correctly', async (t, model) => {
  t.timeout(120000); // 2 minutes timeout for search
  const response = await testServer.executeOperation({
    query: `
      query TestToolCalling($text: String!, $chatHistory: [MultiMessage]!, $model: String) {
        call_tools(
          text: $text,
          chatHistory: $chatHistory,
          model: $model
        ) {
          result
          contextId
          tool
          warnings
          errors
        }
      }
    `,
    variables: {
      text: 'What are the latest developments in renewable energy?',
      chatHistory: [{
        role: 'user',
        content: ['What are the latest developments in renewable energy?']
      }],
      model: model
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const result = response.body?.singleResult?.data?.call_tools.result;
  t.true(result.length > 0, 'Should have a non-empty result');
});

// Test tool calling with a code execution request
runTestForModels('call_tools handles code execution request correctly', async (t, model) => {
  t.timeout(120000); // 2 minutes timeout for code execution
  const response = await testServer.executeOperation({
    query: `
      query TestToolCalling($text: String!, $chatHistory: [MultiMessage]!, $model: String) {
        call_tools(
          text: $text,
          chatHistory: $chatHistory,
          model: $model
        ) {
          result
          contextId
          tool
          warnings
          errors
        }
      }
    `,
    variables: {
      text: 'Write a Python function to calculate fibonacci numbers',
      chatHistory: [{
        role: 'user',
        content: ['Write a Python function to calculate fibonacci numbers']
      }],
      model: model
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const result = response.body?.singleResult?.data?.call_tools.result;
  t.true(result.length > 0, 'Should have a non-empty result');
});

// Test tool calling with a reasoning request
runTestForModels('call_tools handles reasoning request correctly', async (t, model) => {
  t.timeout(120000); // 2 minutes timeout for reasoning
  const response = await testServer.executeOperation({
    query: `
      query TestToolCalling($text: String!, $chatHistory: [MultiMessage]!, $model: String) {
        call_tools(
          text: $text,
          chatHistory: $chatHistory,
          model: $model
        ) {
          result
          contextId
          tool
          warnings
          errors
        }
      }
    `,
    variables: {
      text: 'Explain the implications of quantum computing on cryptography',
      chatHistory: [{
        role: 'user',
        content: ['Explain the implications of quantum computing on cryptography']
      }],
      model: model
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const result = response.body?.singleResult?.data?.call_tools.result;
  t.true(result.length > 0, 'Should have a non-empty result');
});

// Test tool calling with a document request
runTestForModels('call_tools handles document request correctly', async (t, model) => {
  t.timeout(120000); // 2 minutes timeout for document processing
  const response = await testServer.executeOperation({
    query: `
      query TestToolCalling($text: String!, $chatHistory: [MultiMessage]!, $model: String) {
        call_tools(
          text: $text,
          chatHistory: $chatHistory,
          model: $model
        ) {
          result
          contextId
          tool
          warnings
          errors
        }
      }
    `,
    variables: {
      text: 'Summarize the key points from my document about project management',
      chatHistory: [{
        role: 'user',
        content: ['Summarize the key points from my document about project management']
      }],
      model: model
    }
  });

  t.is(response.body?.singleResult?.errors, undefined);
  const result = response.body?.singleResult?.data?.call_tools.result;
  t.true(result.length > 0, 'Should have a non-empty result');
}); 