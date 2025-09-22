import test from 'ava';
import sinon from 'sinon';

const mockPathway = {
  name: 'google_cse',
  temperature: 0.0,
  prompt: '',
};

const mockModel = {
  name: 'google-cse',
  type: 'GOOGLE-CSE',
  url: 'https://www.googleapis.com/customsearch/v1',
  headers: { 'Content-Type': 'application/json' },
  requestsPerSecond: 10,
  maxTokenLength: 200000,
};

test.beforeEach(async t => {
  t.context.sandbox = sinon.createSandbox();
  t.context.originalEnv = { ...process.env };
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.GOOGLE_CSE_KEY = 'test-google-key';
  process.env.GOOGLE_CSE_CX = 'test-google-cx';
  const module = await import('../../../server/plugins/googleCsePlugin.js');
  const GoogleCsePlugin = module.default;
  t.context.plugin = new GoogleCsePlugin(mockPathway, mockModel);
});

test.afterEach.always(t => {
  t.context.sandbox.restore();
  process.env = t.context.originalEnv;
});

test('getRequestParameters builds query params correctly', t => {
  const { plugin } = t.context;
  const text = 'pokemon';
  const parameters = {
    q: 'pokemon cards',
    num: 5,
    start: 2,
    safe: 'active',
    dateRestrict: 'w1',
    siteSearch: 'example.com',
    siteSearchFilter: 'i',
    searchType: 'image',
    gl: 'us',
    hl: 'en',
    lr: 'lang_en',
    sort: 'date',
    exactTerms: 'pikachu',
    excludeTerms: 'fake',
    orTerms: 'deck,booster',
    fileType: 'pdf',
    cx: 'override-cx',
  };

  const result = plugin.getRequestParameters(text, parameters, {});

  t.deepEqual(result, {
    data: [],
    params: {
      key: 'test-google-key',
      cx: 'override-cx',
      q: 'pokemon cards',
      num: 5,
      start: 2,
      safe: 'active',
      dateRestrict: 'w1',
      siteSearch: 'example.com',
      siteSearchFilter: 'i',
      searchType: 'image',
      gl: 'us',
      hl: 'en',
      lr: 'lang_en',
      sort: 'date',
      exactTerms: 'pikachu',
      excludeTerms: 'fake',
      orTerms: 'deck,booster',
      fileType: 'pdf',
    }
  });
});

test('execute sets method GET and calls executeRequest', async t => {
  const { plugin } = t.context;
  const spy = t.context.sandbox.stub(plugin, 'executeRequest').resolves('{"items": []}');

  const cortexRequest = {
    data: null,
    params: null,
    method: null,
    url: mockModel.url,
  };

  const res = await plugin.execute('pokemon', { q: 'pokemon' }, {}, cortexRequest);

  t.is(res, '{"items": []}');
  t.true(spy.calledOnce);
  const calledWith = spy.firstCall.args[0];
  t.is(calledWith.method, 'GET');
  t.is(calledWith.url, 'https://www.googleapis.com/customsearch/v1');
  t.deepEqual(calledWith.params.q, 'pokemon');
});

test('parseResponse returns JSON string', t => {
  const { plugin } = t.context;
  const data = { items: [{ link: 'https://example.com' }] };
  const res = plugin.parseResponse(data);
  t.is(res, JSON.stringify(data));
});
