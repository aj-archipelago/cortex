import test from 'ava';
import OpenAIVisionPlugin from '../../../server/plugins/openAiVisionPlugin.js';

// Minimal mock pathway/model
const mockPathway = { name: 'sys_openai_chat_gpt41', temperature: 0.7 };
const mockModel = { name: 'oai-gpt41', type: 'OPENAI-VISION' };

// This test reproduces a case where items inside messages[].content[]
// are objects missing the required `type` field (e.g., { text: '...' } or { image_url: { url } }).
// The OpenAI Chat Completions API requires content array items to include `type`.
// Expected behavior: Plugin should normalize these to include `type`.
// Current behavior: These objects are passed through unmodified, leading to errors like
// "Missing required parameter: 'messages[N].content[i].type'".

test('normalize untyped content items inside multimodal messages', async (t) => {
  const plugin = new OpenAIVisionPlugin(mockPathway, mockModel);
  // Avoid network calls in tests
  plugin.validateImageUrl = async () => true;

  const messages = [
    {
      role: 'user',
      content: [
        // Untyped text object -> should become { type: 'text', text: '...' }
        { text: 'Hello, I am untyped text content' },
        // Untyped image object -> should become { type: 'image_url', image_url: { url } }
        { image_url: { url: 'https://example.com/image.jpg' } },
        // Already typed should remain unchanged
        { type: 'text', text: 'I am already typed' },
        // Also verify plain strings are converted to typed text
        'Plain string should become typed text'
      ]
    }
  ];

  const parsed = await plugin.tryParseMessages(messages);
  const content = parsed[0].content;

  // Assertions for expected normalized shapes
  t.is(content[0].type, 'text');
  t.is(content[0].text, 'Hello, I am untyped text content');

  t.is(content[1].type, 'image_url');
  t.is(content[1].image_url.url, 'https://example.com/image.jpg');

  t.is(content[2].type, 'text');
  t.is(content[2].text, 'I am already typed');

  t.is(content[3].type, 'text');
  t.is(content[3].text, 'Plain string should become typed text');
});
