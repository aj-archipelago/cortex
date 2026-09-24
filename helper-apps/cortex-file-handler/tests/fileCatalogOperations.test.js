import test from 'ava';
import { Readable } from 'node:stream';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import handler from '../src/index.js';
import { StorageFactory } from '../src/services/storage/StorageFactory.js';
import { StorageService } from '../src/services/storage/StorageService.js';
import { FileConversionService } from '../src/services/FileConversionService.js';
import { getDefaultContainerName, getUserContainerName } from '../src/constants.js';
import { setFileStoreMap, getFileStoreMap } from '../src/redis.js';

async function request(userId, query, method = 'GET', body = undefined) {
  const context = { log() {} };
  await handler(context, { method, body, query: { contextId: userId, userId, fileScope: 'all', ...query }, headers: {} });
  return context.res;
}

test.serial('delete rejects repeated or structured blob paths before resolving storage', async t => {
  for (const blobPath of [['global/a.txt', 'global/b.txt'], { path: 'global/a.txt' }]) {
    const response = await request('catalog-invalid-path', { blobPath }, 'DELETE');
    t.is(response.status, 400);
    t.is(response.body, 'Blob path must be a string');
  }
});

test.serial('native and legacy metadata survive listing, exact lookup, conversion, rename and deletion', async t => {
  const userId = `catalog-test-${Date.now()}`;
  const containerName = getUserContainerName(getDefaultContainerName(), userId);
  const provider = await StorageFactory.getInstance().getAzureProvider(containerName);
  const service = new StorageService();
  await service._initialize();
  const temp = await mkdtemp(path.join(os.tmpdir(), 'catalog-conversion-'));
  try {
    const uploaded = await provider.uploadStream({}, 'opaque.txt', Readable.from('identical bytes'), 'text/plain', 'global', 'تقرير قطر.txt');
    const sibling = await provider.uploadStream({}, 'sibling.txt', Readable.from('identical bytes'), 'text/plain', 'global', 'Sibling.txt');
    await setFileStoreMap('legacy-reference', { url: sibling.url, displayFilename: 'Outdated name' }, userId);
    const listing = await request(userId, { listFolder: true });
    t.is(listing.status, 200);
    t.is(listing.body.files.length, 2);
    t.is(listing.body.files.find(file => file.name === 'global/opaque.txt').displayFilename, 'تقرير قطر.txt');
    t.is(listing.body.files.find(file => file.name === 'global/sibling.txt').displayFilename, 'Sibling.txt');
    const names = await request(userId, { operation: 'listNames', includeMetadata: true });
    t.true(names.body.metadataIncluded);
    t.is(names.body.items.find(item => item[0] === 'global/opaque.txt')[3].displayFilename, 'تقرير قطر.txt');
    const lookup = await request(userId, { blobPath: 'global/opaque.txt', ensureBackup: false });
    t.is(lookup.status, 200);
    t.is(lookup.body.displayFilename, 'تقرير قطر.txt');

    // Converted output must stay in the same scoped container as its original.
    const convertedPath = path.join(temp, 'converted.md');
    await writeFile(convertedPath, 'Converted text');
    const conversion = new FileConversionService({ log() {} }, true, { containerName, displayFilename: 'Original.docx' });
    const converted = await conversion._saveConvertedFile(convertedPath, 'conversion', null, 'global');
    t.true(new URL(converted.url).pathname.includes(`/${containerName}/`));
    const convertedLookup = await request(userId, { blobPath: converted.blobPath, ensureBackup: false });
    t.is(convertedLookup.body.displayFilename, 'Original.docx');
    t.true(convertedLookup.body.contentType.includes('markdown'));

    const renamed = await request(userId, { blobPath: 'global/opaque.txt', rename: true, newFilename: 'Renamed.txt' });
    t.is(renamed.status, 200);
    const renamedLookup = await request(userId, { blobPath: renamed.body.blobPath, ensureBackup: false });
    t.is(renamedLookup.body.displayFilename, 'Renamed.txt');

    const backedUp = await service.ensureGCSUpload({ log() {} }, { url: renamed.body.url, blobPath: renamed.body.blobPath, containerOwnerId: userId });
    t.truthy(backedUp.gcs);
    const deleted = await request(userId, { blobPath: renamed.body.blobPath, fileScope: 'global' }, 'DELETE');
    t.is(deleted.status, 200);
    t.true(deleted.body.deleted);
    t.false(await service.backupProvider.fileExists(backedUp.gcs));
    t.truthy(await getFileStoreMap('legacy-reference', true, userId));
    t.is((await request(userId, { blobPath: 'global/sibling.txt', ensureBackup: false })).status, 200);
    t.is((await request(userId, { blobPath: 'global/sibling.txt', fileScope: 'chat', chatId: 'other' }, 'DELETE')).status, 403);
    await setFileStoreMap('duplicate-reference', { url: sibling.url, gcs: backedUp.gcs }, userId);
    const batch = await request(userId, { fileScope: 'global' }, 'DELETE', {
      blobPaths: ['global/sibling.txt', 'global/missing.txt'],
    });
    t.is(batch.status, 200);
    t.deepEqual(batch.body.results.map(result => result.status), [200, 404]);
    t.falsy(await getFileStoreMap('legacy-reference', true, userId));
    t.falsy(await getFileStoreMap('duplicate-reference', true, userId));
    const rejected = await request(userId, { fileScope: 'global' }, 'DELETE', {
      blobPaths: ['global/okay.txt', 'chats/other/file.txt'],
    });
    t.is(rejected.status, 403);
  } finally {
    const { containerClient } = await provider.getBlobClient({ createContainer: false });
    await containerClient.deleteIfExists();
    await rm(temp, { recursive: true, force: true });
  }
});
