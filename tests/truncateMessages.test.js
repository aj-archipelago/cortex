// ModelPlugin.test.js
import test from 'ava';
import ModelPlugin from '../server/plugins/modelPlugin.js';
import { encode } from 'gpt-3-encoder';
import { mockPathwayResolverString } from './mocks.js';

const { config, pathway, modelName, model } = mockPathwayResolverString;

const modelPlugin = new ModelPlugin(pathway, model);

const generateMessage = (role, content) => ({ role, content });

test('truncateMessagesToTargetLength: should not modify messages if already within target length', (t) => {
  const messages = [
    generateMessage('user', 'Hello, how are you?'),
    generateMessage('assistant', 'I am doing well, thank you!'),
  ];
  const targetTokenLength = encode(modelPlugin.messagesToChatML(messages, false)).length;

  const result = modelPlugin.truncateMessagesToTargetLength(messages, targetTokenLength);
  t.deepEqual(result, messages);
});

test('truncateMessagesToTargetLength: should remove messages from the front until target length is reached', (t) => {
    const messages = [
        generateMessage('user', 'Hello, how are you?'),
        generateMessage('assistant', 'I am doing well, thank you!'),
        generateMessage('user', 'What is your favorite color?'),
    ];
    const targetTokenLength = encode(modelPlugin.messagesToChatML(messages.slice(1), false)).length;

    const result = modelPlugin.truncateMessagesToTargetLength(messages, targetTokenLength);
    t.deepEqual(result, messages.slice(1));
});

test('truncateMessagesToTargetLength: should skip system messages', (t) => {
    const messages = [
      generateMessage('system', 'System message 1'),
      generateMessage('user', 'Hello, how are you?'),
      generateMessage('assistant', 'I am doing well, thank you!'),
    ];
    const targetTokenLength = encode(modelPlugin.messagesToChatML([messages[0], ...messages.slice(2)], false)).length;
  
    const result = modelPlugin.truncateMessagesToTargetLength(messages, targetTokenLength);
    t.deepEqual(result, [messages[0], ...messages.slice(2)]);
});

test('truncateMessagesToTargetLength: should truncate messages to fit target length', (t) => {
  const messages = [
    generateMessage('user', 'Hello, how are you?'),
    generateMessage('assistant', 'I am doing well, thank you!'),
  ];
  const targetTokenLength = encode(modelPlugin.messagesToChatML(messages, false)).length - 4;

  const result = modelPlugin.truncateMessagesToTargetLength(messages, targetTokenLength);
  t.true(result.every((message, index) => message.content.length <= messages[index].content.length));
  t.true(encode(modelPlugin.messagesToChatML(result, false)).length <= targetTokenLength);
});

test('truncateMessagesToTargetLength: should remove messages entirely if they need to be empty to fit target length', (t) => {
  const messages = [
    generateMessage('user', 'Hello, how are you?'),
    generateMessage('assistant', 'I am doing well, thank you!'),
  ];
  const targetTokenLength = encode(modelPlugin.messagesToChatML(messages.slice(1), false)).length;

  const result = modelPlugin.truncateMessagesToTargetLength(messages, targetTokenLength);
  t.deepEqual(result, messages.slice(1));
});

test('truncateMessagesToTargetLength: should return an empty array if target length is 0', (t) => {
  const messages = [
    generateMessage('user', 'Hello, how are you?'),
    generateMessage('assistant', 'I am doing well, thank you!'),
  ];

  const result = modelPlugin.truncateMessagesToTargetLength(messages, 0);
  t.deepEqual(result, []);
});

test('truncateMessagesToTargetLength: should not remove system messages even if they are too long', (t) => {
  const messages = [
      generateMessage('user', 'Hello, how are you?'),
      generateMessage('system', 'System message content that is very long and exceeds the target token length'),
      generateMessage('assistant', 'I am fine, thank you.'),
  ];

  const targetTokenLength = 20;
  const result = modelPlugin.truncateMessagesToTargetLength(messages, targetTokenLength);

  const systemMessage = result.find((message) => message.role === 'system');
  t.truthy(systemMessage, 'System message should not be removed');
  t.is(
      systemMessage.content,
      'System message content that is very long and exceeds the target token length',
      'System message content should not be altered'
  );
});