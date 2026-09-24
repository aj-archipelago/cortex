import test from 'ava';
import jwt from 'jsonwebtoken';
import { generateKeyPairSync } from 'node:crypto';
import { Readable } from 'node:stream';
import FormData from 'form-data';
import handler from '../src/index.js';
import { StorageFactory } from '../src/services/storage/StorageFactory.js';
import { getDefaultContainerName, getUserContainerName } from '../src/constants.js';
import { setFileStoreMap, removeFromFileStoreMap } from '../src/redis.js';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const owner = `grant-integration-${Date.now()}`;
const env = { CFH_GRANT_MODE: 'audit', CFH_GRANT_ISSUER: 'concierge-integration', CFH_GRANT_AUDIENCE: 'cfh-integration', CFH_GRANT_PUBLIC_KEYS: JSON.stringify({ test: publicKey.export({ type: 'spki', format: 'pem' }) }) };
const previous = {};
const sign = (actions, target = { prefix: 'chats/a/' }, subject = owner) => jwt.sign({ v: 1, processFiles: true, targets: [{ owner: subject, ...target, actions }] }, privateKey, { algorithm: 'RS256', keyid: 'test', issuer: env.CFH_GRANT_ISSUER, audience: env.CFH_GRANT_AUDIENCE, subject, expiresIn: 120 });
async function request(token, query, method = 'GET', body) {
  const context = { log() {} };
  await handler(context, { headers: { 'x-cfh-grant': token }, method, body, query: { userId: owner, contextId: owner, fileScope: 'chat', chatId: 'a', ...query } });
  return context.res;
}
async function upload(token, chatId = 'a') {
  const form = new FormData();
  form.append('userId', owner); form.append('fileScope', 'chat'); form.append('chatId', chatId);
  form.append('file', Buffer.from('scoped content'), { filename: 'test.txt', contentType: 'text/plain' });
  const req = Readable.from(form.getBuffer());
  req.headers = { ...form.getHeaders(), 'x-cfh-grant': token }; req.method = 'POST'; req.query = {};
  const context = { log() {} };
  await handler(context, req);
  return context.res;
}
test.before(() => { for (const [key, value] of Object.entries(env)) { previous[key] = process.env[key]; process.env[key] = value; } });
test.after.always(async () => {
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const provider = await StorageFactory.getInstance().getAzureProvider(getUserContainerName(getDefaultContainerName(), owner));
  const { containerClient } = await provider.getBlobClient({ createContainer: false });
  await containerClient.deleteIfExists();
});
test.serial('signed upload, list, lookup, rename and delete preserve chat destination', async t => {
  const token = sign(['read', 'list', 'upload', 'rename', 'delete']);
  const uploaded = await upload(token);
  t.is(uploaded.status, 200); t.true(uploaded.body.blobPath.startsWith('chats/a/'));
  const blobPath = uploaded.body.blobPath;
  const list = await request(token, { listFolder: true });
  t.is(list.status, 200); t.true(list.body.files.some(file => file.name === blobPath));
  const readToken = sign(['read'], { path: blobPath });
  const read = await request(readToken, { blobPath, ensureBackup: false });
  t.is(read.status, 200); t.is(await (await fetch(read.body.url)).text(), 'scoped content');
  t.true(new Date(new URL(read.body.url).searchParams.get('se')).getTime() <= jwt.decode(readToken).exp * 1000);
  t.is((await request(sign(['read']), { blobPath }, 'DELETE')).status, 403);
  t.is((await request(token, { userId: 'another-owner', contextId: 'another-owner', blobPath })).status, 403);
  const renamed = await request(token, { rename: true, blobPath, newFilename: 'renamed.txt' });
  t.is(renamed.status, 200);
  const deleted = await request(token, { blobPath: renamed.body.blobPath }, 'DELETE');
  t.is(deleted.status, 200); t.true(deleted.body.deleted);
});
test.serial('multipart rejection settles without writing another chat', async t => {
  t.is((await upload(sign(['upload']), 'b')).status, 403);
  const provider = await StorageFactory.getInstance().getAzureProvider(getUserContainerName(getDefaultContainerName(), owner));
  t.is((await provider.listFolder('chats/b')).length, 0);
});

test.serial('processing output and cleanup stay inside the signed subject namespace', async t => {
  const token = sign(['read', 'upload', 'delete']);
  const uploaded = await upload(token);
  const requestId = 'processing-check';
  const saved = await request(token, { uri: uploaded.body.url, requestId, save: true });
  t.is(saved.status, 200);
  t.true(new URL(saved.body.url).pathname.includes('/_cfh/'));
  t.true((await fetch(saved.body.url)).ok);
  const cleaned = await request(token, { requestId }, 'DELETE');
  t.is(cleaned.status, 200);
  t.false((await fetch(saved.body.url)).ok);
  t.true((await fetch(uploaded.body.url)).ok);
  await request(token, { blobPath: uploaded.body.blobPath }, 'DELETE');
});

test.serial('network multipart events retain authorization on a real HTTP socket', async t => {
  const { app } = await import('../src/start.js');
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  try {
    const form = new globalThis.FormData();
    form.set('userId', owner); form.set('fileScope', 'chat'); form.set('chatId', 'network-denied');
    form.set('file', new Blob(['not authorized']), 'denied.txt');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/CortexFileHandler`, {
      method: 'POST', body: form, headers: { 'x-cfh-grant': sign(['upload']) },
    });
    t.is(response.status, 403);
    await response.text();
    const provider = await StorageFactory.getInstance().getAzureProvider(getUserContainerName(getDefaultContainerName(), owner));
    t.is((await provider.listFolder('chats/network-denied')).length, 0);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test.serial('legacy shared-root files renew for media, chat, applet and workspace readers without copying', async t => {
  const provider = await StorageFactory.getInstance().getAzureProvider(getDefaultContainerName());
  const { containerClient } = await provider.getBlobClient();
  const blobPath = `${owner}-legacy.png`;
  const blob = containerClient.getBlockBlobClient(blobPath);
  const bytes = Buffer.from('legacy content');
  await blob.uploadData(bytes);
  try {
    for (const target of [{ path: blobPath }, { prefix: '' }, { prefix: 'chats/a/' }, { prefix: 'applet-shared/' }]) {
      const token = sign(['read'], target);
      const result = await request(token, { blobPath, ensureBackup: false });
      t.is(result.status, 200, JSON.stringify(target));
      t.is(new URL(result.body.url).pathname, new URL(blob.url).pathname);
      t.deepEqual(Buffer.from(await (await fetch(result.body.url)).arrayBuffer()), bytes);
      t.true(new Date(new URL(result.body.url).searchParams.get('se')).getTime() <= jwt.decode(token).exp * 1000);
    }
    const workspace = await request(sign(['read'], { prefix: '' }), {
      blobPath, fileScope: 'workspace-shared-legacy', workspaceId: owner, userId: undefined,
    });
    t.is(workspace.status, 200);
    const appletId = '0123456789abcdef01234567', appletOwner = `applet-shared:${appletId}`;
    const applet = await request(sign(['read'], { prefix: 'applet-shared/' }, appletOwner), {
      blobPath, fileScope: 'applet-shared', appletId, contextId: appletOwner, userId: undefined,
    });
    t.is(applet.status, 200);
    const ownerProvider = await StorageFactory.getInstance().getAzureProvider(getUserContainerName(getDefaultContainerName(), owner));
    const { containerClient: ownerContainer } = await ownerProvider.getBlobClient();
    t.false(await ownerContainer.getBlockBlobClient(blobPath).exists(), 'read does not migrate or copy');
    t.true(await blob.exists());
  } finally { await blob.deleteIfExists(); }
});

test.serial('legacy compatibility cannot read modern files across scopes or mutate shared-root files', async t => {
  const provider = await StorageFactory.getInstance().getAzureProvider(getDefaultContainerName());
  const { containerClient } = await provider.getBlobClient();
  const paths = [`${owner}-legacy.txt`, `users/other/${owner}.txt`, `_cfh/other/${owner}.txt`];
  const ownerProvider = await StorageFactory.getInstance().getAzureProvider(getUserContainerName(getDefaultContainerName(), owner));
  const { containerClient: ownerContainer } = await ownerProvider.getBlobClient();
  const modernPath = `chats/b/${owner}.txt`;
  await ownerContainer.getBlockBlobClient(modernPath).uploadData(Buffer.from('private modern file'));
  for (const name of paths) await containerClient.getBlockBlobClient(name).uploadData(Buffer.from('old file'));
  try {
    const read = sign(['read']);
    t.is((await request(read, { blobPath: modernPath })).status, 403);
    for (const blobPath of paths.slice(1)) {
      t.not((await request(sign(['read'], { prefix: '' }), { blobPath })).status, 200);
    }
    const blobPath = paths[0];
    t.is((await request(read, { blobPath, contextId: 'other', userId: 'other' })).status, 403);
    t.is((await request(sign(['upload']), { blobPath })).status, 403);
    t.is((await request(sign(['read'], { path: 'another-file.txt' }), { blobPath })).status, 403);
    t.is((await request(read, { blobPath }, 'DELETE')).status, 403);
    t.is((await request(read, { blobPath, rename: true, newFilename: 'renamed.txt' })).status, 403);
    t.true(await containerClient.getBlockBlobClient(blobPath).exists());
  } finally {
    for (const name of paths) await containerClient.getBlockBlobClient(name).deleteIfExists();
    await ownerContainer.getBlockBlobClient(modernPath).deleteIfExists();
  }
});

test.serial('a scoped historical hash can renew its old shared-root blob', async t => {
  const provider = await StorageFactory.getInstance().getAzureProvider(getDefaultContainerName());
  const { containerClient } = await provider.getBlobClient();
  const blobPath = `${owner}-hash.txt`, hash = `${owner}-hash`;
  const blob = containerClient.getBlockBlobClient(blobPath);
  await blob.uploadData(Buffer.from('historical hash'));
  await setFileStoreMap(hash, { url: blob.url }, owner);
  try {
    const result = await request(sign(['read']), { hash, checkHash: true });
    t.is(result.status, 200);
    t.is(await (await fetch(result.body.url)).text(), 'historical hash');
    t.is((await request(sign(['read']), { hash }, 'DELETE')).status, 403);
  } finally {
    await blob.deleteIfExists();
    await removeFromFileStoreMap(hash, owner);
  }
});
