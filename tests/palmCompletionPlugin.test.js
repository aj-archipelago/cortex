// palmCompletionPlugin.test.js

import test from 'ava';
import PalmCompletionPlugin from '../server/plugins/palmCompletionPlugin.js';
import { mockPathwayResolverString } from './mocks.js';

const { config, pathway, modelName, model } = mockPathwayResolverString;

test.beforeEach((t) => {
  const palmCompletionPlugin = new PalmCompletionPlugin(config, pathway, modelName, model);
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
