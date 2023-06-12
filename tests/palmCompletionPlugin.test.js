// palmCompletionPlugin.test.js

import test from 'ava';
import PalmCompletionPlugin from '../graphql/plugins/palmCompletionPlugin.js';
import { mockConfig } from './mocks.js';

test.beforeEach((t) => {
  const pathway = 'testPathway';
  const palmCompletionPlugin = new PalmCompletionPlugin(mockConfig, pathway);
  t.context = { palmCompletionPlugin };
});

test('getRequestParameters', (t) => {
  const { palmCompletionPlugin } = t.context;
  const text = 'Hello';
  const parameters = { stream: false, name: 'John' };
  const prompt = {prompt:'{{text}} from {{name}}'};

  const requestParameters = palmCompletionPlugin.getRequestParameters(text, parameters, prompt);
  const requestPrompt = requestParameters.instances[0].prompt;

  t.is(requestPrompt, 'Hello from John');
});

test('parseResponse', (t) => {
  const { palmCompletionPlugin } = t.context;
  const responseData = {
    predictions: [
      {
        content: 'Hello, how can I help you today?',
      },
    ],
  };

  const expectedResult = 'Hello, how can I help you today?';

  t.is(palmCompletionPlugin.parseResponse(responseData), expectedResult);
});

test('getSafetyAttributes', (t) => {
  const { palmCompletionPlugin } = t.context;
  const responseData = {
    predictions: [
      {
        safetyAttributes: {
          blocked: false,
        },
      },
    ],
  };

  const expectedResult = {
    blocked: false,
  };

  t.deepEqual(palmCompletionPlugin.getSafetyAttributes(responseData), expectedResult);
});

test('logRequestData', (t) => {
  const { palmCompletionPlugin } = t.context;
  const data = {
    instances: [
      {
        prompt: 'Hello, how can I help you?',
      },
    ],
  };
  const responseData = {
    predictions: [
      {
        content: 'Hello, how can I help you today?',
      },
    ],
  };
  const prompt = { debugInfo: '' };

  const consoleLog = console.log;
  let logOutput = '';
  console.log = (msg) => (logOutput += msg + '\n');

  palmCompletionPlugin.logRequestData(data, responseData, prompt);

  console.log = consoleLog;

  t.true(logOutput.includes('Hello, how can I help you?'));
  t.true(logOutput.includes('> Hello, how can I help you today?'));
});