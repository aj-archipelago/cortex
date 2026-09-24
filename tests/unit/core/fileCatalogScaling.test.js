import test from 'ava';

process.env.WHISPER_MEDIA_API_URL = 'http://media-helper.test';
const { axios } = await import('../../../lib/requestExecutor.js');
const { listFilesForFileAccessPlan, createContextFileRef, findFileInFileAccessPlanDirect } = await import('../../../lib/fileUtils.js');
const { default: pathway } = await import('../../../pathways/system/entity/tools/sys_tool_file_collection.js');

const plan = [{ kind: 'user-global', userContextId: 'user', write: true }];
test.beforeEach(t => { t.context.get = axios.get; t.context.delete = axios.delete; });
test.afterEach.always(t => { axios.get = t.context.get; axios.delete = t.context.delete; });

test.serial('equal legacy hashes at different cloud locations remain separate files', async t => {
  axios.get = async () => ({ data: { files: [
    { name: 'global/a.txt', hash: 'old-hash', url: 'https://store.test/user/global/a.txt' },
    { name: 'global/b.txt', hash: 'old-hash', url: 'https://store.test/user/global/b.txt' },
  ] } });
  const files = await listFilesForFileAccessPlan(plan);
  t.is(files.length, 2);
});

test.serial('a selected cloud location never lists a catalog to fill missing metadata', async t => {
  const calls = [];
  axios.get = async url => {
    calls.push(new URL(url));
    return { status: 200, data: { url: 'https://store.test/user/global/a.txt' } };
  };
  const file = await findFileInFileAccessPlanDirect(createContextFileRef('user', 'global/a.txt'), plan);
  t.truthy(file.url);
  t.is(calls.length, 1);
  t.is(calls[0].searchParams.get('blobPath'), 'global/a.txt');
});

test.serial('failed exact paths do not fall through to filename search or another folder', async t => {
  let calls = 0;
  axios.get = async url => { calls++; t.is(new URL(url).searchParams.get('blobPath'), 'global/a.txt'); return { status: 404 }; };
  t.is(await findFileInFileAccessPlanDirect('global/a.txt', plan), null);
  t.is(calls, 1);
});

test.serial('a compact catalog miss does not invoke full listing', async t => {
  let calls = 0;
  axios.get = async url => {
    calls++;
    t.is(new URL(url).searchParams.get('operation'), 'listNames');
    return { data: { items: [['global/a.txt', 1, null]], metadataIncluded: true } };
  };
  t.is(await findFileInFileAccessPlanDirect('missing.txt', plan), null);
  t.is(calls, 1);
});

test.serial('LIST selects before resolving URLs and bounds concurrent requests', async t => {
  let resolved = 0, active = 0, maxActive = 0;
  axios.get = async url => {
    const params = new URL(url).searchParams;
    if (params.get('operation') === 'listNames') return { data: {
      metadataIncluded: true, truncated: false,
      items: Array.from({ length: 15000 }, (_, i) => [`global/${String(i).padStart(5, '0')}.txt`, 1, new Date(i * 1000).toISOString()]),
    } };
    t.is(params.get('ensureBackup'), 'false');
    resolved++; active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    return { status: 200, data: { url: `https://store.test/user/${params.get('blobPath')}` } };
  };
  const result = JSON.parse(await pathway.executePathway({ args: { operation: 'list', fileAccessPlan: plan, limit: 7 }, resolver: {} }));
  t.true(result.success);
  t.is(result.totalFiles, 15000);
  t.is(resolved, 7);
  t.true(maxActive <= 4);
  t.is(result.files[0].blobPath, 'global/14999.txt');
});

test.serial('REMOVE deletes hashless locations and counts only successful deletions', async t => {
  axios.get = async url => {
    const params = new URL(url).searchParams;
    t.is(params.get('includeMetadata'), 'false');
    t.is(params.get('ensureBackup'), 'false');
    return { status: 200, data: { url: `https://store.test/user/${params.get('blobPath')}` } };
  };
  const deleted = [];
  let calls = 0;
  axios.delete = async (url, options) => {
    calls++;
    const params = new URL(url).searchParams;
    t.false(params.has('hash'));
    deleted.push(...options.data.blobPaths);
    return { status: 200, data: { results: options.data.blobPaths.map(blobPath => ({
      blobPath, deleted: blobPath.endsWith('a.txt'), status: blobPath.endsWith('a.txt') ? 200 : 403,
    })) } };
  };
  const result = JSON.parse(await pathway.executePathway({ args: {
    operation: 'remove', fileAccessPlan: plan, fileIds: ['global/a.txt', 'global/a.txt', 'global/b.txt'],
  }, resolver: {} }));
  t.false(result.success);
  t.is(result.removedCount, 1);
  t.deepEqual(deleted, ['global/a.txt', 'global/b.txt']);
  t.is(calls, 1);
});

test.serial('a chat write grant does not make a user-wide file writable', async t => {
  axios.get = async () => ({ status: 200, data: { url: 'https://store.test/user/global/a.txt' } });
  const accessPlan = [
    { kind: 'chat', userContextId: 'user', chatId: 'chat', write: true },
    { kind: 'user-files', userContextId: 'user' },
  ];
  const file = await findFileInFileAccessPlanDirect(createContextFileRef('user', 'global/a.txt'), accessPlan);
    t.false(file._writeTarget);
});

test.serial('search refreshes a cached miss without loading full file URLs', async t => {
    const requests = [];
    axios.get = async url => {
        const params = new URL(url).searchParams;
        requests.push(params);
        return { data: {
            metadataIncluded: true,
            cacheHit: params.get('fresh') !== 'true',
            items: params.get('fresh') === 'true' ? [['global/new.txt', 1, null]] : [],
        } };
    };
    const result = JSON.parse(await pathway.executePathway({ args: {
        operation: 'search', query: 'new', fileAccessPlan: plan,
    }, resolver: {} }));
    t.is(result.count, 1);
    t.is(requests.length, 2);
    t.true(requests.every(params => params.get('operation') === 'listNames'));
    t.is(requests[1].get('fresh'), 'true');
});

test.serial('new cloud file entries use location references without generating a hash', async t => {
    const { addFileToCollection, ensureShortLivedUrl } = await import('../../../lib/fileUtils.js');
    const url = 'https://store.blob.core.windows.net/user/global/new.txt';
    const entry = await addFileToCollection('user', null, url, 'New.txt');
    t.is(entry.id, createContextFileRef('user', 'global/new.txt'));
    t.falsy(entry.hash);
    axios.get = async requestUrl => {
        const params = new URL(requestUrl).searchParams;
        t.is(params.get('blobPath'), 'global/new.txt');
        t.false(params.has('hash'));
        return { status: 200, data: { url: `${url}?fresh=true` } };
    };
    const refreshed = await ensureShortLivedUrl(entry, 'http://media-helper.test', 'user');
    t.is(refreshed.url, `${url}?fresh=true`);
});
