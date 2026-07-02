import test from 'ava';

import bingSearchTool, {
  normalizeBingAgentResults,
} from '../../../pathways/system/entity/tools/sys_tool_bing_search.js';

test('Bing search tool keeps backup internet search function disabled until configured', (t) => {
  const definition = bingSearchTool.toolDefinition.function;

  t.false(bingSearchTool.toolDefinition.enabled);
  t.is(bingSearchTool.toolDefinition.icon, '🧭');
  t.is(definition.name, 'SearchInternetBing');
  t.true(definition.description.includes('backup internet search tool'));
  t.truthy(definition.parameters.properties.q);
  t.truthy(definition.parameters.properties.query);
});

test('normalizeBingAgentResults accepts CSE-like JSON results', (t) => {
  const results = normalizeBingAgentResults(JSON.stringify({
    results: [
      {
        title: 'Example title',
        url: 'https://example.com/story',
        content: 'Example snippet',
      },
    ],
  }));

  t.is(results.length, 1);
  t.is(results[0].title, 'Example title');
  t.is(results[0].url, 'https://example.com/story');
  t.is(results[0].content, 'Example snippet');
  t.truthy(results[0].searchResultId);
});

test('normalizeBingAgentResults extracts markdown links when agent returns prose', (t) => {
  const results = normalizeBingAgentResults(`
1. [Example News](https://example.com/news)
   This is the snippet from the hosted agent.
`);

  t.is(results.length, 1);
  t.is(results[0].title, 'Example News');
  t.is(results[0].url, 'https://example.com/news');
  t.is(results[0].content, 'This is the snippet from the hosted agent.');
});

test('normalizeBingAgentResults falls back to one text result', (t) => {
  const results = normalizeBingAgentResults('No links, but useful search context.', 'test query');

  t.is(results.length, 1);
  t.is(results[0].title, 'Bing search results for: test query');
  t.is(results[0].url, '');
  t.is(results[0].content, 'No links, but useful search context.');
});
