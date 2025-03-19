// ModelPlugin.test.js
import test from 'ava';
import ModelPlugin from '../server/plugins/modelPlugin.js';
import { encode } from '../lib/encodeCache.js';
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

test('truncateMessagesToTargetLength: should prioritize final user message', (t) => {
  const messages = [
    generateMessage('system', 'System message'),
    generateMessage('user', 'First user message'),
    generateMessage('assistant', 'Assistant response'),
    generateMessage('user', 'Final important question that should be preserved'),
  ];
  
  // Set target length to only fit the final user message
  const finalUserMsg = messages[messages.length - 1];
  const targetTokenLength = encode(modelPlugin.messagesToChatML([finalUserMsg], false)).length;
  
  const result = modelPlugin.truncateMessagesToTargetLength(messages, targetTokenLength);
  t.is(result.length, 1, 'Should only keep final user message');
  t.is(result[0].role, 'user', 'Should be a user message');
  t.is(result[0].content, finalUserMsg.content, 'Should preserve final user message content');
});

test('truncateMessagesToTargetLength: should prioritize final user message with tight constraints', (t) => {
  const messages = [
    generateMessage('system', 'System message content that is very long and exceeds the target token length'),
    generateMessage('user', 'Hello, how are you?'),
    generateMessage('assistant', 'I am fine, thank you.'),
    generateMessage('user', 'Final user message'),
  ];

  // Very tight token constraint
  const targetTokenLength = 25;
  const result = modelPlugin.truncateMessagesToTargetLength(messages, targetTokenLength);

  // Should prioritize final user message
  t.is(result.length, 1, 'Should keep only the final user message with tight constraints');
  t.is(result[0].role, 'user', 'Should keep the user message');
  t.is(result[0].content.length <= messages[3].content.length, true, 'User message may be truncated');
});

test('truncateMessagesToTargetLength: should add truncation markers to shortened messages', (t) => {
  // Create a very long message that will definitely be truncated
  const longContent = 'a'.repeat(1000);
  
  const messages = [
    generateMessage('system', 'System message: ' + longContent),
    generateMessage('user', 'Final user message: ' + longContent),
  ];

  // Set a target token length that will force heavy truncation
  const targetTokenLength = 20;
  const result = modelPlugin.truncateMessagesToTargetLength(messages, targetTokenLength);
  
  // Verify truncation markers are added
  const expectedMarker = "[truncated]";
  
  // Check if at least one message has the truncation marker
  const hasMarker = result.some(msg => msg.content.includes(expectedMarker));
  t.true(hasMarker, 'At least one message should have truncation marker');
  
  // Verify individual messages
  result.forEach(msg => {
    // Only verify messages that were actually truncated
    if (msg.content.length < 1000) {
      t.true(msg.content.includes(expectedMarker), 
        `Truncated ${msg.role} message should include truncation marker`);
    }
  });
});

test('truncateMessagesToTargetLength: should not add truncation markers to messages that fit completely', (t) => {
  const messages = [
    generateMessage('system', 'Short system message'),
    generateMessage('user', 'Short user message'),
    generateMessage('assistant', 'Short assistant message'),
    generateMessage('user', 'Another short user message'),
  ];

  // Set a target token length that allows all messages to fit
  const targetTokenLength = encode(modelPlugin.messagesToChatML(messages, false)).length;
  const result = modelPlugin.truncateMessagesToTargetLength(messages, targetTokenLength);
  
  // Verify no truncation markers are added
  const expectedMarker = "[truncated]";
  
  // None of the messages should have the truncation marker
  const hasMarker = result.some(msg => msg.content.includes(expectedMarker));
  t.false(hasMarker, 'No message should have a truncation marker when all fit completely');
  
  // Verify content is unchanged
  result.forEach((msg, index) => {
    t.is(msg.content, messages[index].content, 
      `${msg.role} message content should be unchanged`);
  });
});

test('truncateMessagesToTargetLength: should handle extreme token constraints with markers', (t) => {
  // Create a very long message that will definitely be truncated
  const longContent = 'a'.repeat(1000);
  
  const messages = [
    generateMessage('system', 'System message: ' + longContent),
    generateMessage('user', 'Final user message: ' + longContent),
  ];

  // Extremely tight token constraint
  const targetTokenLength = 30;
  const result = modelPlugin.truncateMessagesToTargetLength(messages, targetTokenLength);

  // Verify result
  t.true(result.length > 0, 'Should have at least one message');
  
  // The kept message should have the truncation marker
  const expectedMarker = "[truncated]";
  t.true(result[0].content.includes(expectedMarker), 
    'Extremely truncated message should include truncation marker');
});

test('truncateMessagesToTargetLength: should maintain message order', (t) => {
  const messages = [
    generateMessage('system', 'System message'),
    generateMessage('user', 'First user message'),
    generateMessage('assistant', 'Assistant response'),
    generateMessage('user', 'Second user message'),
    generateMessage('assistant', 'Second assistant response'),
    generateMessage('user', 'Final user message'),
  ];
  
  // Set target length to fit all messages
  const targetTokenLength = encode(modelPlugin.messagesToChatML(messages, false)).length;
  
  const result = modelPlugin.truncateMessagesToTargetLength(messages, targetTokenLength);
  t.deepEqual(result.map(m => m.role), messages.map(m => m.role), 'Message order should be preserved');
});

test('truncateMessagesToTargetLength: should return an empty array if target length is 0', (t) => {
  const messages = [
    generateMessage('user', 'Hello, how are you?'),
    generateMessage('assistant', 'I am doing well, thank you!'),
  ];

  const result = modelPlugin.truncateMessagesToTargetLength(messages, 0);
  t.deepEqual(result, []);
});