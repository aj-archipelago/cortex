import test from 'ava';
import sinon from 'sinon';

const mockPathway = {
  name: 'brave_search',
  temperature: 0.0,
  prompt: '',
};

const mockModel = {
  name: 'brave-search',
  type: 'BRAVE-SEARCH',
  url: 'https://api.search.brave.com/res/v1/web/search',
  headers: { Accept: 'application/json' },
  requestsPerSecond: 10,
  maxTokenLength: 200000,
};

const importBraveSearchPlugin = async () => {
  const module = await import(`../../../server/plugins/braveSearchPlugin.js?test=${Date.now()}-${Math.random()}`);
  return module.default;
};

test.beforeEach(async t => {
  t.context.sandbox = sinon.createSandbox();
  t.context.originalEnv = { ...process.env };
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.BRAVE_SEARCH_API_KEY = 'test-brave-key';
  const BraveSearchPlugin = await importBraveSearchPlugin();
  t.context.plugin = new BraveSearchPlugin(mockPathway, mockModel);
});

test.afterEach.always(t => {
  t.context.sandbox.restore();
  process.env = t.context.originalEnv;
});

test('getRequestParameters builds Brave query params and headers correctly', t => {
  const { plugin } = t.context;
  const result = plugin.getRequestParameters('fallback query', {
    q: 'latest Gaza news',
    country: 'us',
    search_lang: 'en',
    ui_lang: 'en-US',
    count: 12,
    offset: 2,
    safesearch: 'moderate',
    freshness: 'pw',
    text_decorations: false,
    spellcheck: true,
    result_filter: 'web,news',
    goggles_id: 'sample-goggle',
    units: 'metric',
    extra_snippets: true,
    summary: false,
  }, {});

  t.deepEqual(result, {
    data: [],
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': 'test-brave-key',
    },
    params: {
      q: 'latest Gaza news',
      country: 'us',
      search_lang: 'en',
      ui_lang: 'en-US',
      count: 12,
      offset: 2,
      safesearch: 'moderate',
      freshness: 'pw',
      text_decorations: false,
      spellcheck: true,
      result_filter: 'web,news',
      goggles_id: 'sample-goggle',
      units: 'metric',
      extra_snippets: true,
      summary: false,
    },
  });
});

test('execute sets method GET and calls executeRequest', async t => {
  const { plugin } = t.context;
  const spy = t.context.sandbox.stub(plugin, 'executeRequest').resolves('{"web":{"results":[]}}');

  const cortexRequest = {
    data: null,
    headers: null,
    params: null,
    method: null,
    url: mockModel.url,
  };

  const res = await plugin.execute('pokemon', { q: 'pokemon' }, {}, cortexRequest);

  t.is(res, '{"web":{"results":[]}}');
  t.true(spy.calledOnce);
  const calledWith = spy.firstCall.args[0];
  t.is(calledWith.method, 'GET');
  t.is(calledWith.url, 'https://api.search.brave.com/res/v1/web/search');
  t.deepEqual(calledWith.params.q, 'pokemon');
  t.is(calledWith.headers['X-Subscription-Token'], 'test-brave-key');
});

test('parseResponse returns JSON string', t => {
  const { plugin } = t.context;
  const data = { web: { results: [{ url: 'https://example.com' }] } };
  const res = plugin.parseResponse(data);
  t.is(res, JSON.stringify(data));
});

test('getRequestParameters throws error when query is empty', t => {
  const { plugin } = t.context;

  t.throws(() => {
    plugin.getRequestParameters('', {}, {});
  }, { message: 'Brave Search requires a non-empty query parameter (q or text)' });

  t.throws(() => {
    plugin.getRequestParameters(undefined, { q: '' }, {});
  }, { message: 'Brave Search requires a non-empty query parameter (q or text)' });

  t.throws(() => {
    plugin.getRequestParameters('   ', {}, {});
  }, { message: 'Brave Search requires a non-empty query parameter (q or text)' });
});
