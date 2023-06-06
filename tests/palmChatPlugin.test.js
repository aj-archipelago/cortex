// test_palmChatPlugin.js
import test from 'ava';
import PalmChatPlugin from '../graphql/plugins/palmChatPlugin.js';
import { mockConfig } from './mocks.js';

test.beforeEach((t) => {
  const pathway = 'testPathway';
  const palmChatPlugin = new PalmChatPlugin(mockConfig, pathway);
  t.context = { palmChatPlugin };
});

test('convertMessagesToPalm', (t) => {
  const { palmChatPlugin } = t.context;
  const messages = [
    { role: 'system', content: 'System Message' },
    { role: 'user', content: 'User Message' },
    { role: 'user', content: 'User Message 2'},
    { role: 'assistant', content: 'Assistant Message' },
  ];

  const expectedResult = {
    messages: [
      { author: 'user', content: 'User Message\nUser Message 2' },
      { author: 'assistant', content: 'Assistant Message' },
    ],
    context: 'System Message',
  };

  t.deepEqual(palmChatPlugin.convertMessagesToPalm(messages), expectedResult);
});

test('convertMessagesToPalm - already PaLM format', (t) => {
    const { palmChatPlugin } = t.context;
    const messages = [
      { author: 'user', content: 'User Message' },
      { author: 'user', content: 'User Message 2'},
      { author: 'assistant', content: 'Assistant Message' },
    ];
  
    const expectedResult = {
      messages: [
        { author: 'user', content: 'User Message\nUser Message 2' },
        { author: 'assistant', content: 'Assistant Message' },
      ],
      context: '',
    };
  
    t.deepEqual(palmChatPlugin.convertMessagesToPalm(messages), expectedResult);
  });

  test('convertMessagesToPalm - empty string roles', (t) => {
    const { palmChatPlugin } = t.context;
    const messages = [
      { role: '', content: 'Empty role message' },
      { role: 'user', content: 'User Message' },
      { role: 'assistant', content: 'Assistant Message' },
    ];
  
    const expectedResult = {
      messages: [
        { author: 'user', content: 'User Message' },
        { author: 'assistant', content: 'Assistant Message' },
      ],
      context: '',
    };
  
    t.deepEqual(palmChatPlugin.convertMessagesToPalm(messages), expectedResult);
  });
  
  test('convertMessagesToPalm - consecutive system messages', (t) => {
    const { palmChatPlugin } = t.context;
    const messages = [
      { role: 'system', content: 'System Message 1' },
      { role: 'system', content: 'System Message 2' },
      { role: 'user', content: 'User Message' },
      { role: 'assistant', content: 'Assistant Message' },
    ];
  
    const expectedResult = {
      messages: [
        { author: 'user', content: 'User Message' },
        { author: 'assistant', content: 'Assistant Message' },
      ],
      context: 'System Message 1\nSystem Message 2',
    };
  
    t.deepEqual(palmChatPlugin.convertMessagesToPalm(messages), expectedResult);
  });
  
  test('convertMessagesToPalm - multiple authors', (t) => {
    const { palmChatPlugin } = t.context;
    const messages = [
      { role: 'system', content: 'System Message' },
      { author: 'user1', content: 'User1 Message' },
      { author: 'user1', content: 'User1 Message 2' },
      { author: 'user2', content: 'User2 Message' },
      { author: 'assistant', content: 'Assistant Message' },
    ];
  
    const expectedResult = {
      messages: [
        { author: 'user1', content: 'User1 Message\nUser1 Message 2' },
        { author: 'user2', content: 'User2 Message' },
        { author: 'assistant', content: 'Assistant Message' },
      ],
      context: 'System Message',
    };
  
    t.deepEqual(palmChatPlugin.convertMessagesToPalm(messages), expectedResult);
  });
  
  test('convertMessagesToPalm - no messages', (t) => {
    const { palmChatPlugin } = t.context;
    const messages = [];
  
    const expectedResult = {
      messages: [],
      context: '',
    };
  
    t.deepEqual(palmChatPlugin.convertMessagesToPalm(messages), expectedResult);
  });
  
  test('convertMessagesToPalm - only system messages', (t) => {
    const { palmChatPlugin } = t.context;
    const messages = [
      { role: 'system', content: 'System Message 1' },
      { role: 'system', content: 'System Message 2' },
    ];
  
    const expectedResult = {
      messages: [],
      context: 'System Message 1\nSystem Message 2',
    };
  
    t.deepEqual(palmChatPlugin.convertMessagesToPalm(messages), expectedResult);
  });

test('getCompiledContext', (t) => {
  const { palmChatPlugin } = t.context;
  const text = 'Hello';
  const parameters = { name: 'John' };
  const context = '{{text}} from {{name}}';

  const expectedResult = 'Hello from John';

  t.is(palmChatPlugin.getCompiledContext(text, parameters, context), expectedResult);
});

test('getCompiledExamples', (t) => {
  const { palmChatPlugin } = t.context;
  const text = 'Greetings';
  const parameters = { name: 'Jane' };
  const examples = [
    {
      input: { content: 'Input: {{text}} from {{name}}' },
      output: { content: 'Output: {{text}} to {{name}}' },
    },
  ];

  const expectedResult = [
    {
      input: { content: 'Input: Greetings from Jane' },
      output: { content: 'Output: Greetings to Jane' },
    },
  ];

  t.deepEqual(palmChatPlugin.getCompiledExamples(text, parameters, examples), expectedResult);
});

test('getRequestParameters', (t) => {
  const { palmChatPlugin } = t.context;
  const text = 'Hello';
  const parameters = { stream: false, name: 'John'};
  const messages = [
    { role: 'system', content: 'System Message' },
    { role: 'user', content: 'Hello' },
    { role: 'assistant', content: 'What can I do for you?' },
  ];
  const prompt = { context: '{{text}} from {{name}}', examples: [], messages };

  const requestParameters = palmChatPlugin.getRequestParameters(text, parameters, prompt);
  const requestMessages = requestParameters.instances[0].messages;

  t.is(requestMessages[0].author, 'user');
  t.is(requestMessages[0].content, 'Hello');
});

test('getSafetyAttributes', (t) => {
  const { palmChatPlugin } = t.context;
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

  t.deepEqual(palmChatPlugin.getSafetyAttributes(responseData), expectedResult);
});

test('parseResponse', (t) => {
  const { palmChatPlugin } = t.context;
  const responseData = {
    predictions: [
      {
        candidates: [
          {
            content: 'Hello, how can I help you today?',
          },
        ],
      },
    ],
  };

  const expectedResult = 'Hello, how can I help you today?';

  t.is(palmChatPlugin.parseResponse(responseData), expectedResult);
});

test('logRequestData', (t) => {
  const { palmChatPlugin } = t.context;
  const data = {
    instances: [
      {
        messages: [
          { author: 'user', content: 'Hello' },
          { author: 'assistant', content: 'How can I help you?' },
        ],
      },
    ],
  };
  const responseData = {
    predictions: [
      {
        candidates: [
          {
            content: 'Hello, how can I help you today?',
          },
        ],
      },
    ],
  };
  const prompt = { debugInfo: '' };

  const consoleLog = console.log;
  let logOutput = '';
  console.log = (msg) => (logOutput += msg + '\n');

  palmChatPlugin.logRequestData(data, responseData, prompt);

  console.log = consoleLog;

  t.true(logOutput.includes('Message 1:'));
  t.true(logOutput.includes('Message 2:'));
  t.true(logOutput.includes('> Hello, how can I help you today?'));
});