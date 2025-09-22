import test from 'ava';
import sinon from 'sinon';

const mockGoogleResponse = {
  searchInformation: {
    totalResults: '123',
    searchTime: 0.12
  },
  items: [
    {
      title: 'Pikachu - Wikipedia',
      link: 'https://en.wikipedia.org/wiki/Pikachu',
      snippet: 'Pikachu is a species of Pokémon...'
    },
    {
      title: 'Pokemon News - Official Site',
      link: 'https://www.pokemon.com/us',
      snippet: 'The official source for Pokémon news...'
    }
  ]
};

// Build a minimal stub pathway for google_cse returning canned results
const buildStubGooglePathway = () => ({
  name: 'google_cse',
  // Simulate the core rootResolver returning data.result
  rootResolver: async () => {
    return { result: JSON.stringify(mockGoogleResponse) };
  }
});

// Build a minimal resolver object to pass to executePathway
const buildResolver = () => ({
  errors: [],
  tool: null,
  mergeResults: () => {},
});

// Ensure required env vars exist before importing config/tool
const setEnv = (t) => {
  t.context.originalEnv = { ...process.env };
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.GOOGLE_CSE_KEY = 'test-google-key';
  process.env.GOOGLE_CSE_CX = 'test-google-cx';
};

const restoreEnv = (t) => {
  process.env = t.context.originalEnv;
};

// We import modules lazily after env vars are set to avoid config init errors
const loadModules = async () => {
  const { config } = await import('../config.js');
  const toolModule = await import('../pathways/system/entity/tools/sys_tool_google_search.js');
  return { config, tool: toolModule.default };
};

// Helper to inject stub google_cse pathway
const injectStubPathway = (config) => {
  const existing = config.get('pathways') || {};
  const modified = { ...existing, google_cse: buildStubGooglePathway() };
  config.load({ pathways: modified });
};

// Test: normalization to SearchResponse

test('sys_tool_google_search normalizes Google items into SearchResponse', async (t) => {
  setEnv(t);
  const { config, tool } = await loadModules();
  injectStubPathway(config);

  const resolver = buildResolver();
  const args = { q: 'pokemon', userMessage: 'testing' };

  const resultStr = await tool.executePathway({ args, runAllPrompts: null, resolver });
  t.truthy(resultStr, 'Should return a stringified JSON response');

  const result = JSON.parse(resultStr);
  t.is(result._type, 'SearchResponse');
  t.true(Array.isArray(result.value));

  // Normalized items should match the CSE items length
  const items = result.value;
  t.is(items.length, mockGoogleResponse.items.length);
  t.truthy(items[0].searchResultId);
  t.is(items[0].title, mockGoogleResponse.items[0].title);
  t.is(items[0].url, mockGoogleResponse.items[0].link);
  t.is(items[0].content, mockGoogleResponse.items[0].snippet);

  // Tool metadata is set
  t.truthy(resolver.tool);
  const toolMeta = JSON.parse(resolver.tool);
  t.is(toolMeta.toolUsed, 'GoogleSearch');

  restoreEnv(t);
});
