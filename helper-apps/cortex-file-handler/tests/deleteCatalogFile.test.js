import test from 'ava';
import { deleteCatalogFile, deleteCatalogFiles } from '../src/utils/deleteCatalogFile.js';

function fixture() {
  const calls = [];
  const client = {
    url: 'https://store.test/user/global/a.txt',
    exists: async () => true,
    deleteIfExists: async () => calls.push('primary'),
  };
  const service = {
    getBackupProvider: async () => ({ bucketName: 'backup' }),
    _getExpectedGCSBlobName: () => 'user/global/a.txt',
    deleteFileFromBackup: async url => calls.push(url),
  };
  const args = {
    clients: [client], records: {}, storageService: service,
    removeRecord: async key => calls.push(`remove:${key}`),
    saveRecord: async (key, record) => calls.push({ key, record }),
  };
  return { calls, client, service, args };
}

test('hashless path deletion cleans up its deterministic backup', async t => {
  const f = fixture();
  t.deepEqual(await deleteCatalogFile(f.args), { found: true });
  t.deepEqual(f.calls, ['gs://backup/user/global/a.txt', 'primary']);
});

test('deletion retires only metadata for the actual object, after backup success', async t => {
  const f = fixture();
  f.args.records = {
    same: { url: f.client.url, gcs: 'gs://backup/user/global/a.txt' },
    other: { url: 'https://store.test/user/chats/x/a.txt' },
  };
  await deleteCatalogFile(f.args);
  t.deepEqual(f.calls, ['gs://backup/user/global/a.txt', 'primary', 'remove:same']);
});

test('failed backup retains metadata and can be retried after primary is gone', async t => {
  const f = fixture();
  f.args.records = { old: { url: f.client.url, gcs: 'gs://backup/user/global/a.txt' } };
  f.service.deleteFileFromBackup = async () => { throw new Error('backup unavailable'); };
  await t.throwsAsync(deleteCatalogFile(f.args));
  t.deepEqual(f.calls, []);
  f.client.exists = async () => false;
  f.service.deleteFileFromBackup = async url => f.calls.push(url);
  t.deepEqual(await deleteCatalogFile(f.args), { found: true });
  t.is(f.calls.at(-1), 'remove:old');
});

test('a primary failure retains metadata for retry', async t => {
  const f = fixture();
  f.client.deleteIfExists = async () => { throw new Error('storage unavailable'); };
  await t.throwsAsync(deleteCatalogFile(f.args));
  t.deepEqual(f.calls, ['gs://backup/user/global/a.txt']);
});

test('a converted file deletion preserves the original and its legacy reference', async t => {
  const f = fixture();
  f.args.records = { old: { url: 'https://store.test/user/global/a.docx', converted: { url: f.client.url } } };
  await deleteCatalogFile(f.args);
  t.deepEqual(f.calls.at(-1), { key: 'old', record: { url: 'https://store.test/user/global/a.docx' } });
});

async function batchFixture(count = 2, legacy = 5000) {
  const f = fixture();
  let scans = 0;
  let visited = 0;
  const records = new Map();
  for (let i = 0; i < legacy; i++) records.set(`key-${i}`, { url: `https://store.test/user/global/${i}.txt`, gcs: `gs://backup/old/${i}` });
  // Duplicate legacy records must both contribute backup pointers.
  records.set('duplicate', { url: 'https://store.test/user/global/0.txt', gcs: 'gs://backup/other/0' });
  const args = { ...f.args,
    items: Array.from({ length: count }, (_, i) => ({ blobPath: `global/${i}.txt`,
      clients: [{ ...f.client, url: `https://store.test/user/global/${i}.txt` }] })),
    scanRecords: async function* () {
      scans++;
      for (const [key, record] of records) {
        visited++;
        yield [key, record, JSON.stringify(record)];
        if (visited % 128 === 0) await new Promise(resolve => setImmediate(resolve));
      }
    },
    commitRecord: async (key, expected, replacement) => {
      if (JSON.stringify(records.get(key)) !== expected) throw new Error('changed');
      if (replacement) records.set(key, replacement); else records.delete(key);
    },
  };
  return { ...f, args, records, stats: () => ({ scans, visited }) };
}

test('50 deletions share one paged scan and preserve all duplicate backup pointers', async t => {
  const f = await batchFixture(50);
  let yielded = false;
  setImmediate(() => { yielded = true; });
  const results = await deleteCatalogFiles(f.args);
  t.true(results.every(result => result.deleted));
  t.deepEqual(f.stats(), { scans: 1, visited: 5001 });
  t.true(yielded);
  t.true(f.calls.includes('gs://backup/old/0'));
  t.true(f.calls.includes('gs://backup/other/0'));
  t.is(f.records.size, 4950);
});

test('partial scan failure deletes nothing', async t => {
  const f = await batchFixture();
  f.args.scanRecords = async function* () {
    yield ['x', { url: f.client.url }, '{}'];
    throw new Error('Redis unavailable');
  };
  await t.throwsAsync(deleteCatalogFiles(f.args));
  t.deepEqual(f.calls, []);
});

test('batch keeps a failed backup addressable and reports other successes', async t => {
  const f = await batchFixture();
  f.service.deleteFileFromBackup = async url => {
    if (url === 'gs://backup/old/0') throw new Error('unavailable');
    f.calls.push(url);
  };
  const results = await deleteCatalogFiles(f.args);
  t.deepEqual(results.map(result => result.deleted), [false, true]);
  t.true(f.records.has('key-0'));
  t.false(f.records.has('key-1'));
  t.is(f.calls.filter(call => call === 'primary').length, 1);
});

test('original and conversion in one batch do not resurrect a removed pointer', async t => {
  const f = await batchFixture();
  f.records.clear();
  f.records.set('pair', { url: f.args.items[0].clients[0].url,
    converted: { url: f.args.items[1].clients[0].url, gcs: 'gs://backup/converted' } });
  const results = await deleteCatalogFiles(f.args);
  t.true(results.every(result => result.deleted));
  t.is(f.records.size, 0);
  t.true(f.calls.includes('gs://backup/converted'));
});

test('concurrent metadata change is reported as retryable without overwriting it', async t => {
  const f = await batchFixture(1);
  f.args.commitRecord = async () => { throw new Error('changed'); };
  const results = await deleteCatalogFiles(f.args);
  t.false(results[0].deleted);
  t.is(results[0].status, 500);
  t.true(f.records.has('key-0'));
});
