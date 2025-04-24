// ModelPlugin.test.js
import test from 'ava';
import ModelPlugin from '../server/plugins/modelPlugin.js';
import { encode } from '../lib/encodeCache.js';
import { mockPathwayResolverString } from './mocks.js';

const { config, pathway, modelName, model } = mockPathwayResolverString;

const modelPlugin = new ModelPlugin(pathway, model);

const generateMessage = (role, content) => ({ role, content });
const generateStructuredMessage = (role, content) => ({ role, content: [{ type: 'text', text: content }] });

test('truncateMessagesToTargetLength: should not modify messages if already within target length', (t) => {
  const messages = [
    generateMessage('user', 'Hello, how are you?'),
    generateMessage('assistant', 'I am doing well, thank you!'),
  ];
  const targetTokenLength = modelPlugin.countMessagesTokens(messages);

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
  
  // Set target length to only fit the final user message plus the minimum safety margin
  const finalUserMsg = messages[messages.length - 1];
  const targetTokenLength = modelPlugin.countMessagesTokens([finalUserMsg]) * 1.1;
  
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
  const targetTokenLength = 15;
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
  const expectedMarker = "[...]";
  
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
  const expectedMarker = "[...]";
  
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
  const expectedMarker = "[...]";
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

test('truncateMessagesToTargetLength: should return messages with [...] if target length is 0', (t) => {
  const messages = [
    generateMessage('user', 'Hello, how are you?'),
    generateMessage('assistant', 'I am doing well, thank you!'),
  ];

  const result = modelPlugin.truncateMessagesToTargetLength(messages, null, 0);
  
  // Should return all messages but with [...] content
  t.is(result.length, messages.length, 'Should return all messages');
  
  // Each message should be truncated to just the marker
  result.forEach(msg => {
    t.is(msg.content, '[...]', 'Message content should be just the truncation marker');
  });
});

test('truncateMessagesToTargetLength: should handle structured messages with maxMessageTokenLength=0', (t) => {
  const messages = [
    generateStructuredMessage('user', 'Hello, how are you?'),
    generateStructuredMessage('assistant', 'I am doing well, thank you!'),
  ];

  const result = modelPlugin.truncateMessagesToTargetLength(messages, null, 0);
  
  // Should return all messages but with [...] content
  t.is(result.length, messages.length, 'Should return all structured messages');
  
  // Each message should be truncated to just a single content item with the marker
  result.forEach(msg => {
    t.true(Array.isArray(msg.content), 'Content should still be an array');
    t.is(msg.content.length, 1, 'Should have exactly one content item');
    t.is(msg.content[0].type, 'text', 'Content item should be of type text');
    t.is(msg.content[0].text, '[...]', 'Content text should be just the truncation marker');
  });
});

// New tests for maxMessageTokenLength

test('truncateMessagesToTargetLength: should respect maxMessageTokenLength constraint', (t) => {
  // Create messages with different lengths
  const longContent = 'a'.repeat(1000);
  
  const messages = [
    generateMessage('user', 'Short first message'),
    generateMessage('assistant', longContent),
    generateMessage('user', 'Short final message'),
  ];
  
  // Set a target that would fit all messages normally
  const targetTokenLength = modelPlugin.countMessagesTokens(messages) + 100;
  
  // Calculate tokens in the assistant message
  const assistantMsgTokens = modelPlugin.countMessagesTokens([messages[1]]);
  
  // Set maxMessageTokenLength to be less than the assistant message length
  const maxMessageTokenLength = Math.floor(assistantMsgTokens * 0.3); 
  
  const result = modelPlugin.truncateMessagesToTargetLength(messages, targetTokenLength, maxMessageTokenLength);
  
  // All messages should be present
  t.is(result.length, 3, 'All messages should be preserved');
  
  // Only the long message should be truncated
  t.is(result[0].content, messages[0].content, 'First message should be unchanged');
  t.is(result[2].content, messages[2].content, 'Last message should be unchanged');
  
  // The assistant message should be truncated
  t.true(result[1].content.length < longContent.length, 'Long message should be truncated');
  t.true(result[1].content.includes('[...]'), 'Truncated message should have marker');
  
  // Calculate tokens in the truncated message
  const truncatedMsgTokens = modelPlugin.countMessagesTokens([result[1]]);
  
  // Allow small buffer for truncation marker
  t.true(truncatedMsgTokens <= maxMessageTokenLength + 10, 
    `Truncated message (${truncatedMsgTokens} tokens) should not exceed maxMessageTokenLength (${maxMessageTokenLength} tokens) by more than buffer`);
});

test('truncateMessagesToTargetLength: should handle very small maxMessageTokenLength', (t) => {
  const messages = [
    generateMessage('system', 'System message that will definitely need to be truncated to fit the maxMessageTokenLength'),
    generateMessage('user', 'This is a user message that will need to be heavily truncated to fit the maxMessageTokenLength'),
  ];
  
  // Set a large target token length
  const targetTokenLength = 1000;
  
  // But set a very small maxMessageTokenLength
  const maxMessageTokenLength = 5;
  
  const result = modelPlugin.truncateMessagesToTargetLength(messages, targetTokenLength, maxMessageTokenLength);
  
  // All messages should be present but truncated
  t.is(result.length, 2, 'Both messages should be present');
  
  // Both messages should be truncated to fit the maxMessageTokenLength
  result.forEach(msg => {
    const msgTokens = modelPlugin.safeGetEncodedLength(msg.content);
    t.true(msgTokens <= maxMessageTokenLength + 5, 
      `Message (${msgTokens} tokens) should not exceed maxMessageTokenLength (${maxMessageTokenLength}) by more than buffer`);
    t.true(msg.content.includes('[...]'), 'Truncated message should have marker');
  });
});

test('truncateMessagesToTargetLength: should handle both constraints together', (t) => {
  const longContent = 'a'.repeat(500);
  
  const messages = [
    generateMessage('system', 'System: ' + longContent),
    generateMessage('user', 'User: ' + longContent),
    generateMessage('assistant', 'Assistant: ' + longContent),
    generateMessage('user', 'Final: ' + longContent),
  ];
  
  // Set a moderate target token length
  const targetTokenLength = 300;
  
  // And a moderate maxMessageTokenLength
  const maxMessageTokenLength = 100;
  
  const result = modelPlugin.truncateMessagesToTargetLength(messages, targetTokenLength, maxMessageTokenLength);
  
  // We should have some messages, but not necessarily all
  t.true(result.length > 0 && result.length <= messages.length, 'Should have some messages');
  
  // Total token count should be below target
  const totalTokens = modelPlugin.countMessagesTokens(result);
  t.true(totalTokens <= targetTokenLength, 
    `Total tokens (${totalTokens}) should not exceed target length (${targetTokenLength})`);
  
  // Each message should respect maxMessageTokenLength
  result.forEach(msg => {
    const msgTokens = modelPlugin.countMessagesTokens([msg]);
    t.true(msgTokens <= maxMessageTokenLength + 10, 
      `Message (${msgTokens} tokens) should not exceed maxMessageTokenLength (${maxMessageTokenLength}) by more than buffer`);
  });
});

test('truncateMessagesToTargetLength: maxMessageTokenLength should not affect unchanged messages', (t) => {
  const messages = [
    generateMessage('system', 'Short system message'),
    generateMessage('user', 'Short user message'),
  ];
  
  // Calculate tokens in each message
  const systemMsgTokens = modelPlugin.countMessagesTokens([messages[0]]);
  const userMsgTokens = modelPlugin.countMessagesTokens([messages[1]]);
  
  // Set maxMessageTokenLength above individual message sizes but below their sum
  const maxMessageTokenLength = Math.max(systemMsgTokens, userMsgTokens) + 10;
  
  // Set target length to fit all messages
  const targetTokenLength = modelPlugin.countMessagesTokens(messages) + 20;
  
  const result = modelPlugin.truncateMessagesToTargetLength(messages, targetTokenLength, maxMessageTokenLength);
  
  // All messages should be unchanged
  t.is(result.length, 2, 'Both messages should be present');
  t.is(result[0].content, messages[0].content, 'First message should be unchanged');
  t.is(result[1].content, messages[1].content, 'Second message should be unchanged');
  
  // No truncation markers
  const hasMarker = result.some(msg => msg.content.includes('[...]'));
  t.false(hasMarker, 'No message should have truncation marker');
});

test('truncateMessagesToTargetLength: should truncate long messages with maxMessageTokenLength', t => {
  const longText = 'A'.repeat(6000);
  const messages = [
    generateMessage('user', longText),
    generateMessage('assistant', 'Response'),
    generateMessage('user', 'Short message')
  ];
  
  const shortMsgTokens = modelPlugin.countMessagesTokens([{ role: 'user', content: 'Short message' }]);
  const maxMessageTokenLength = shortMsgTokens * 2; // Just enough to force truncation of long messages
  
  // Large target to ensure only maxMessageTokenLength constraint is active
  const targetTokenLength = 10000; 
  
  const result = modelPlugin.truncateMessagesToTargetLength(messages, targetTokenLength, maxMessageTokenLength);
  
  // Check that long message was truncated
  const longMsgTokens = modelPlugin.countMessagesTokens([result[0]]);
  t.true(longMsgTokens <= maxMessageTokenLength + 10, 
    `Long message (${longMsgTokens} tokens) should be truncated to near maxMessageTokenLength (${maxMessageTokenLength})`);
  t.true(result[0].content.includes('[...]'), 'Truncated message should have truncation marker');
  
  // Short messages should be unchanged
  t.is(result[1].content, 'Response');
  t.is(result[2].content, 'Short message');
});

test('truncateMessagesToTargetLength: should not truncate image content with maxMessageTokenLength', t => {
  const longText = 'A'.repeat(6000);
  const imageContent = { type: 'image_url', url: 'image.jpg' };
  const longTextContent = { type: 'text', text: longText };
  const messages = [
    generateMessage('user', [imageContent, longTextContent]),
    generateMessage('assistant', 'I see an image')
  ];
  
  // Calculate tokens for image + some text
  const imageTokens = 100; // Estimate from countMessagesTokens
  const maxMessageTokenLength = imageTokens + 50; // Enough for image but not all text
  
  // Large target to ensure only maxMessageTokenLength constraint is active
  const targetTokenLength = 10000;
  
  const result = modelPlugin.truncateMessagesToTargetLength(messages, targetTokenLength, maxMessageTokenLength);
  
  // Image should be preserved
  t.deepEqual(result[0].content[0], imageContent, 'Image content should be preserved');
  
  // Text should be truncated
  t.true(result[0].content[1].text.length < longText.length, 'Text content should be truncated');
  t.true(result[0].content[1].text.includes('[...]'), 'Truncated text should have marker');
  
  // Check overall message length
  const msgTokens = modelPlugin.countMessagesTokens([result[0]]);
  t.true(msgTokens <= maxMessageTokenLength + 10,
    `Message tokens (${msgTokens}) should not exceed maxMessageTokenLength (${maxMessageTokenLength}) by more than buffer`);
});

test('truncateMessagesToTargetLength: should truncate array content with maxMessageTokenLength', t => {
  const longText1 = 'A'.repeat(3000);
  const longText2 = 'B'.repeat(3000); 
  const longTextContent1 = { type: 'text', text: longText1 };
  const longTextContent2 = { type: 'text', text: longText2 };
  const messages = [
    generateMessage('user', [longTextContent1, longTextContent2]),
    generateMessage('assistant', 'Response')
  ];
  
  // Set a moderate maxMessageTokenLength
  const maxMessageTokenLength = 200;
  
  // Large target to ensure only maxMessageTokenLength constraint is active
  const targetTokenLength = 10000;
  
  const result = modelPlugin.truncateMessagesToTargetLength(messages, targetTokenLength, maxMessageTokenLength);
  
  // Check that message was truncated
  const msgTokens = modelPlugin.countMessagesTokens([result[0]]);
  t.true(msgTokens <= maxMessageTokenLength + 10,
    `Message tokens (${msgTokens}) should not exceed maxMessageTokenLength (${maxMessageTokenLength}) by more than buffer`);
  
  // At least one of the text items should be truncated
  const hasMarker = result[0].content.some(item => 
    typeof item === 'string' && item.includes('[...]') ||
    item.type === 'text' && item.text.includes('[...]'));
  t.true(hasMarker, 'At least one content item should have truncation marker');
});

test('truncateMessagesToTargetLength: should handle mixed message types with maxMessageTokenLength', t => {
  const longText = 'A'.repeat(10000);
  const shortText = 'Short message';
  const imageContent = { type: 'image_url', url: 'image.jpg' };
  const longTextContent = { type: 'text', text: longText };
  const shortTextContent = { type: 'text', text: shortText };
  
  const messages = [
    generateMessage('user', shortText),
    generateMessage('assistant', longText),
    generateMessage('user', [shortTextContent, imageContent, longTextContent]),
    generateMessage('system', longText)
  ];
  
  // Calculate reasonable maxMessageTokenLength
  const shortMsgTokens = modelPlugin.countMessagesTokens([{ role: 'user', content: shortText }]);
  const maxMessageTokenLength = 200; // Force truncation of long messages
  
  // Large target to ensure only maxMessageTokenLength constraint is active
  const targetTokenLength = 10000;
  
  const result = modelPlugin.truncateMessagesToTargetLength(messages, targetTokenLength, maxMessageTokenLength);
  
  // Short message should be unchanged
  t.is(result[0].content, shortText, 'Short message should be unchanged');
  
  // Long text messages should be truncated
  t.true(result[1].content.length < longText.length, 'Long text message should be truncated');
  t.true(result[1].content.includes('[...]'), 'Truncated message should have marker');
  t.true(result[3].content.length < longText.length, 'Long system message should be truncated');
  
  // Check multimodal message
  t.deepEqual(result[2].content[1], imageContent, 'Image should be preserved');
  if (typeof result[2].content[1] === 'string') {
    t.true(result[2].content[1].length < longText.length, 'Text in multimodal message should be truncated');
  } else if (result[2].content[1] && result[2].content[1].type === 'text') {
    t.true(result[2].content[1].text.length < longText.length, 'Text in multimodal message should be truncated');
  }
  
  // All messages should respect maxMessageTokenLength
  result.forEach((msg, i) => {
    const msgTokens = modelPlugin.countMessagesTokens([msg]);
    t.true(msgTokens <= maxMessageTokenLength + 10,
      `Message ${i} tokens (${msgTokens}) should not exceed maxMessageTokenLength (${maxMessageTokenLength}) by more than buffer`);
  });
});