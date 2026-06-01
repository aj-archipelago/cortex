import test from 'ava';
import fs from 'fs';
import path from 'path';
import { encode } from '../../../lib/encodeCache.js';
import { getFirstNToken } from '../../../server/chunker.js';
import Claude3VertexPlugin from '../../../server/plugins/claude3VertexPlugin.js';
import ModelPlugin from '../../../server/plugins/modelPlugin.js';
import { mockPathwayResolverMessages } from '../../helpers/mocks.js';

const { pathway, model } = mockPathwayResolverMessages;
const testDataCache = new Map();

// Helper function to load test data from files
function loadTestData(filename) {
  if (testDataCache.has(filename)) {
    return testDataCache.get(filename);
  }

  let content;
  try {
    const filePath = path.join(process.cwd(), 'tests', 'data', filename);
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    // Return a smaller fallback test string if file loading fails
    content = 'a '.repeat(1000);
  }

  testDataCache.set(filename, content);
  return content;
}

const largeContent = loadTestData('largeContent.txt');
const mixedContent = loadTestData('mixedContent.txt');

// Test the token count estimation accuracy
test('token count estimation accuracy', async (t) => {
  const plugin = new Claude3VertexPlugin(pathway, model);

  // Calculate the estimated token count using the sampling method
  const estimatedTokens = plugin.safeGetEncodedLength(largeContent);

  // Calculate the actual token count by using the direct encoder on a smaller sample
  // and scaling up (since the pattern is uniform)
  const sampleSize = Math.min(100000, largeContent.length);
  const sample = largeContent.substring(0, sampleSize);
  const sampleTokens = encode(sample).length;
  const projectedRatio = largeContent.length / sample.length;
  const actualTokensEstimate = Math.ceil(sampleTokens * projectedRatio);

  // With our implementation, we should be overestimating
  // Check that the estimated tokens is greater than the actual tokens
  t.true(estimatedTokens >= actualTokensEstimate,
    'Token count should overestimate to ensure we never exceed token limits');

  // Since we're specifically testing with highly repetitive test data,
  // allow a higher overestimation percentage (up to 75% for test)
  const overestimationPercentage = (estimatedTokens - actualTokensEstimate) / actualTokensEstimate * 100;
  t.true(overestimationPercentage <= 75,
    `Overestimation should be reasonable (got ${overestimationPercentage.toFixed(2)}%, max allowed 75%)`);
});

// Test safeGetEncodedLength with different content types
test('safeGetEncodedLength with various content types', async (t) => {
  const plugin = new ModelPlugin(pathway, model);

  // Split the mixed content into chunks to test with different segments
  const chunks = mixedContent.split('===').filter(chunk => chunk.trim().length > 0);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk.length < 1000) continue; // Skip very short chunks

    // Get direct token count (actual)
    const directTokenCount = encode(chunk).length;

    // Get estimated token count
    const estimatedTokenCount = plugin.safeGetEncodedLength(chunk);

    // Verify we're overestimating
    t.true(estimatedTokenCount >= directTokenCount,
      `Token count for content type #${i+1} should overestimate`);
  }
});

// Test truncateMessagesToTargetLength function
test('truncateMessagesToTargetLength preserves recent content', async (t) => {
  const plugin = new Claude3VertexPlugin(pathway, model);

  // Create a conversation with mixed message sizes
  const messages = [
    { role: 'system', content: 'System message' },
    { role: 'user', content: 'Short first user message' },
    { role: 'assistant', content: 'Short assistant response' },
    { role: 'user', content: largeContent.substring(0, 50000) }, // Large middle message
    { role: 'assistant', content: 'Another short reply' },
    { role: 'user', content: 'Final important question that should be preserved' }
  ];

  // Set a target token length that forces truncation
  const targetTokenLength = 10000;

  // Truncate messages
  const truncatedMessages = plugin.truncateMessagesToTargetLength(messages, targetTokenLength);

  // Verify the system message is preserved
  t.true(truncatedMessages[0].role === 'system', 'System message should be preserved');

  // Verify the last user message is preserved
  const lastUserMessageIndex = truncatedMessages
    .map(m => m.role)
    .lastIndexOf('user');

  t.true(lastUserMessageIndex >= 0, 'At least one user message should be preserved');

  if (lastUserMessageIndex >= 0) {
    const lastUserMessage = truncatedMessages[lastUserMessageIndex];
    t.true(lastUserMessage.content.includes('Final important question'),
      'The last user message should be preserved');
  }

  // Verify the total token count is now below the target
  const totalTokens = plugin.safeGetEncodedLength(
    plugin.messagesToChatML(truncatedMessages, false)
  );

  t.true(totalTokens <= targetTokenLength,
    `Total token count (${totalTokens}) should be less than or equal to target (${targetTokenLength})`);
});

test('getFirstNToken handles large content token budgets accurately', (t) => {
  const fullTokenCount = encode(largeContent).length;
  const tokenCounts = [100, 500, 1000, 2000, 100000];

  for (const tokenCount of tokenCounts) {
    const truncatedText = getFirstNToken(largeContent, tokenCount);
    const actualTokenCount = encode(truncatedText).length;

    t.true(actualTokenCount <= tokenCount,
      `Truncated text should have at most ${tokenCount} tokens (got ${actualTokenCount})`);

    const minAcceptableTokens = tokenCount < 200 ? tokenCount - 20 : tokenCount * 0.8;
    t.true(actualTokenCount >= minAcceptableTokens || actualTokenCount === fullTokenCount,
      `Truncated text should have close to ${tokenCount} tokens when possible`);

    if (truncatedText.length > 0) {
      t.false(truncatedText.endsWith(' '), 'Result should not end with a space');

      const lastWord = truncatedText.split(' ').pop();
      t.true(largeContent.includes(lastWord), 'Last word should be complete');
    }
  }
});

// Comprehensive tests for getFirstNTokenSingle
test('getFirstNTokenSingle handles various text types and lengths', (t) => {
  // Test cases with different characteristics
  const testCases = [
    {
      name: 'empty text',
      text: '',
      maxTokens: 100,
      expected: ''
    },
    {
      name: 'short text under limit',
      text: 'This is a short text that should not be truncated.',
      maxTokens: 100,
      expected: 'This is a short text that should not be truncated.'
    },
    {
      name: 'text with special characters',
      text: 'Text with special chars: !@#$%^&*()_+{}[]|\\:;"<>,.?/~`',
      maxTokens: 50,
      expected: 'Text with special chars: !@#$%^&*()_+{}[]|\\:;"<>,.?/~`'
    },
    {
      name: 'text with unicode characters',
      text: 'Text with unicode: 你好世界 🌍 🌎 🌏',
      maxTokens: 50,
      expected: 'Text with unicode: 你好世界 🌍 🌎 🌏'
    },
    {
      name: 'text with repeated words',
      text: 'word '.repeat(1000),
      maxTokens: 100,
    },
    {
      name: 'text with long words',
      text: 'supercalifragilisticexpialidocious '.repeat(100),
      maxTokens: 100,
    }
  ];

  for (const testCase of testCases) {
    const result = getFirstNToken(testCase.text, testCase.maxTokens);

    // Basic validation
    t.true(encode(result).length <= testCase.maxTokens,
      `${testCase.name}: Result should not exceed max tokens`);

    // For non-empty results, verify we don't end with a partial word
    if (result.length > 0) {
      t.false(result.endsWith(' '),
        `${testCase.name}: Result should not end with a space`);

      // Check that we don't have a partial word at the end
      const lastWord = result.split(' ').pop();
      t.true(testCase.text.includes(lastWord),
        `${testCase.name}: Last word should be complete`);
    }

    // For expected results, verify exact match
    if (testCase.expected) {
      t.is(result, testCase.expected,
        `${testCase.name}: Result should match expected output`);
    }
  }
});

test('getFirstNTokenSingle handles edge cases and boundary conditions', (t) => {
  // Test with very small token counts
  const smallText = 'This is a test sentence.';
  const smallResult = getFirstNToken(smallText, 1);
  t.true(encode(smallResult).length <= 1,
    'Should handle very small token counts');

  // Test with very large token counts
  const largeText = 'word '.repeat(10000);
  const largeResult = getFirstNToken(largeText, 5000);
  t.true(encode(largeResult).length <= 5000,
    'Should handle very large token counts');

  // Test with zero tokens
  const zeroResult = getFirstNToken('any text', 0);
  t.is(zeroResult, '',
    'Should return empty string for zero tokens');

  // Test with negative tokens
  const negativeResult = getFirstNToken('any text', -1);
  t.is(negativeResult, '',
    'Should return empty string for negative tokens');

  // Test with null/undefined text
  const nullResult = getFirstNToken(null, 100);
  t.is(nullResult, '',
    'Should handle null text');

  const undefinedResult = getFirstNToken(undefined, 100);
  t.is(undefinedResult, '',
    'Should handle undefined text');

  // Test with text containing only spaces
  const spacesResult = getFirstNToken('   ', 100);
  t.is(spacesResult.trim(), '',
    'Should handle text with only spaces');

  // Test with text containing only newlines
  const newlinesResult = getFirstNToken('\n\n\n', 100);
  t.is(newlinesResult.trim(), '',
    'Should handle text with only newlines');
});

test('getFirstNTokenSingle maintains text quality and readability', (t) => {
  // Test with text containing paragraphs
  const paragraphText = `First paragraph with some content.
Second paragraph with different content.
Third paragraph with more content.`;

  const paragraphResult = getFirstNToken(paragraphText, 50);

  // Verify we don't cut in the middle of a paragraph
  const paragraphs = paragraphResult.split('\n\n');
  for (const para of paragraphs) {
    t.true(paragraphText.includes(para),
      'Should preserve complete paragraphs when possible');
  }

  // Test with text containing lists
  const listText = `1. First item
2. Second item
3. Third item`;

  const listResult = getFirstNToken(listText, 30);

  // Verify we don't cut in the middle of a list item
  const items = listResult.split('\n');
  for (const item of items) {
    if (item.trim()) {
      t.true(listText.includes(item),
        'Should preserve complete list items when possible');
    }
  }

  // Test with text containing code blocks
  const codeText = `function test() {
  console.log("Hello");
  return true;
}`;

  const codeResult = getFirstNToken(codeText, 40);

  // Verify we don't cut in the middle of code blocks
  t.true(codeText.includes(codeResult),
    'Should preserve complete code blocks when possible');
});

// Test handling of very large messages that exceed token limits
test('handles messages exceeding token limit', async (t) => {
  const plugin = new Claude3VertexPlugin(pathway, model);

  // Set manageTokenLength directly on the plugin's promptParameters
  plugin.promptParameters.manageTokenLength = true;

  // Create a simple text prompt for testing
  class TestPrompt {
    constructor(props) {
      this.messages = props.messages;
    }
  }

  // Create a simplified test prompt
  const customPrompt = new TestPrompt({
    messages: [
      { role: 'system', content: 'System message' },
      { role: 'user', content: largeContent },
      { role: 'assistant', content: 'Assistant response' },
      { role: 'user', content: 'Final question?' }
    ]
  });

  // Set up the parameters
  const parameters = {
    stream: false
  };

  // Call getRequestParameters with our custom prompt
  const requestParameters = await plugin.getRequestParameters(
    'Help me',
    parameters,
    customPrompt
  );

  // Verify we got a result
  t.truthy(requestParameters);
  t.truthy(requestParameters.messages);

  // Verify system message is preserved
  t.is(requestParameters.system, 'System message');

  // Get total content length after truncation
  const totalContentLength = requestParameters.messages.reduce((total, msg) => {
    if (Array.isArray(msg.content)) {
      return total + msg.content.reduce((sum, item) => {
        return sum + (item.text ? item.text.length : 0);
      }, 0);
    }
    return total;
  }, 0);

  // Should be truncated (less than original)
  t.true(totalContentLength < largeContent.length, 'Message content should be truncated');

  // Final user message should be preserved
  const lastUserMessage = requestParameters.messages[requestParameters.messages.length - 1];
  t.is(lastUserMessage.role, 'user');
  t.true(Array.isArray(lastUserMessage.content) &&
    lastUserMessage.content.some(c => c.type === 'text' && c.text && c.text.includes('Final question')),
    'Final user message should be preserved');

  // Verify total token count is within model's limit
  const totalTokens = plugin.safeGetEncodedLength(
    plugin.messagesToChatML(requestParameters.messages, false)
  );
  const maxTokens = plugin.getModelMaxPromptTokens();
  t.true(totalTokens <= maxTokens,
    `Total token count (${totalTokens}) should be within model limit (${maxTokens})`);
});

// Test truncateMessagesToTargetLength with very long content
test('truncateMessagesToTargetLength handles very long content', async (t) => {
  const plugin = new Claude3VertexPlugin(pathway, model);

  // Create a conversation with very long content
  const messages = [
    { role: 'system', content: 'System message' },
    { role: 'user', content: largeContent }, // Very long message
    { role: 'assistant', content: 'Short response' },
    { role: 'user', content: largeContent }, // Another very long message
    { role: 'assistant', content: 'Another short response' },
    { role: 'user', content: 'Final important question that should be preserved' }
  ];

  // Get the model's max token length
  const maxTokens = plugin.getModelMaxPromptTokens();

  // Truncate messages
  const truncatedMessages = plugin.truncateMessagesToTargetLength(messages, maxTokens);

  // Verify we got a result
  t.truthy(truncatedMessages, 'Should return truncated messages');
  t.true(truncatedMessages.length > 0, 'Should have at least one message');

  // Verify the last user message is preserved
  const lastUserMessage = truncatedMessages[truncatedMessages.length - 1];
  t.is(lastUserMessage.role, 'user');
  t.true(lastUserMessage.content.includes('Final important question'),
    'Final user message should be preserved');

  // Verify total token count is within limit
  const totalTokens = plugin.countMessagesTokens(truncatedMessages);
  t.true(totalTokens <= maxTokens,
    `Total token count (${totalTokens}) should be within model limit (${maxTokens})`);

  // Verify we're getting a reasonable amount of content
  const minAcceptableTokens = maxTokens * 0.8; // Should use at least 80% of available tokens
  t.true(totalTokens >= minAcceptableTokens,
    `Should use a reasonable amount of available tokens (got ${totalTokens}, expected at least ${minAcceptableTokens})`);

  // Verify message order is preserved
  const originalOrder = messages.map(m => m.role);
  const truncatedOrder = truncatedMessages.map(m => m.role);
  t.deepEqual(truncatedOrder, originalOrder.slice(0, truncatedOrder.length),
    'Message order should be preserved');

  // Verify no messages are empty
  for (const msg of truncatedMessages) {
    t.true(msg.content && msg.content.length > 0,
      'No messages should be empty');
  }

});

// Test truncateMessagesToTargetLength with very long content for per message token length
test('truncateMessagesToTargetLength handles very long content for per message token length', async (t) => {
  const plugin = new Claude3VertexPlugin(pathway, model);

  // Create a conversation with very long content
  const messages = [
    { role: 'system', content: 'System message' },
    { role: 'user', content: largeContent }, // Very long message as a single string
    { role: 'assistant', content: 'Short response' },
    { role: 'user', content: [{type: 'text', text: largeContent}, {type: 'text', text: largeContent}] }, // Another very long message as an array of text objects
    { role: 'assistant', content: 'Another short response' },
    { role: 'user', content: [largeContent, largeContent] }, // Another very long message as an array of strings
    { role: 'assistant', content: 'A third short response' },
    { role: 'user', content: 'Final important question that should be preserved' }
  ];

  // Get the model's max token length
  const maxTokens = plugin.getModelMaxPromptTokens();

  // Truncate messages
  const truncatedMessages = plugin.truncateMessagesToTargetLength(messages, null, 1000);

  // Verify we got a result
  t.truthy(truncatedMessages, 'Should return truncated messages');
  t.true(truncatedMessages.length > 0, 'Should have at least one message');

  // Verify the last user message is preserved
  const lastUserMessage = truncatedMessages[truncatedMessages.length - 1];
  t.is(lastUserMessage.role, 'user');
  t.true(lastUserMessage.content.includes('Final important question'),
    'Final user message should be preserved');

  // Verify total token count is within limit
  const totalTokens = plugin.countMessagesTokens(truncatedMessages);
  t.true(totalTokens <= maxTokens,
    `Total token count (${totalTokens}) should be within model limit (${maxTokens})`);

  // Verify message order is preserved
  const originalOrder = messages.map(m => m.role);
  const truncatedOrder = truncatedMessages.map(m => m.role);
  t.deepEqual(truncatedOrder, originalOrder.slice(0, truncatedOrder.length),
    'Message order should be preserved');

  // Verify no messages are empty
  for (const msg of truncatedMessages) {
    t.true(msg.content && msg.content.length > 0,
      'No messages should be empty');
  }

  truncatedMessages.forEach((msg, i) => {
    const msgTokens = plugin.countMessagesTokens([msg]);
    t.true(msgTokens <= 1010, `Message ${i + 1} tokens (${msgTokens}) should be near target limit (1000)`);
  });
});
