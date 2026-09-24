import test from 'ava';
import jwt from 'jsonwebtoken';
import { generateKeyPairSync } from 'node:crypto';
import { assertGrantedPath, verifyStorageGrant, withStorageGrant, limitGrantExpiry } from '../src/security/storageGrant.js';
import { handleWithStorageGrant, authorizeHandlerOperation, scopedProcessingId } from '../src/security/grantRequest.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = { CFH_GRANT_ISSUER: 'concierge-test', CFH_GRANT_AUDIENCE: 'cfh-test',
  CFH_GRANT_PUBLIC_KEYS: JSON.stringify({ test: publicKey.export({ type: 'spki', format: 'pem' }) }) };
const sign = (claims = {}, options = {}) => jwt.sign({ v: 1, processFiles: true,
  targets: [{ owner: 'alice', prefix: 'chats/a/', actions: ['read', 'list', 'upload', 'rename', 'delete'] }], ...claims },
privateKey, { algorithm: 'RS256', keyid: 'test', issuer: env.CFH_GRANT_ISSUER, audience: env.CFH_GRANT_AUDIENCE,
  subject: 'alice', expiresIn: 120, ...options });

test('valid grant is a bearer capability, scoped by owner, path and operation', t => {
  const token = sign();
  const claims = verifyStorageGrant(token, env);
  withStorageGrant({ token, claims }, () => {
    t.notThrows(() => assertGrantedPath('alice', 'chats/a/file.txt', 'read'));
    t.throws(() => assertGrantedPath('bob', 'chats/a/file.txt', 'read'));
    t.throws(() => assertGrantedPath('alice', 'chats/ab/file.txt', 'read'));
    t.throws(() => assertGrantedPath('alice', 'chats/a/../b/file.txt', 'read'));
    t.throws(() => assertGrantedPath('alice', 'chats/a\\file.txt', 'read'));
    t.true(limitGrantExpiry(new Date(Date.now() + 3600000)).getTime() <= claims.exp * 1000);
  });
});

test('invalid signature, algorithm, audience, expiry and unsigned payload are rejected', t => {
  t.throws(() => verifyStorageGrant(sign({}, { audience: 'cfh-other' }), env));
  t.throws(() => verifyStorageGrant(sign({}, { expiresIn: -30 }), env));
  t.throws(() => verifyStorageGrant(sign({}, { expiresIn: 7200 }), env));
  t.throws(() => verifyStorageGrant(sign().slice(0, -20) + 'tampered', env));
  t.throws(() => verifyStorageGrant(jwt.sign({ sub: 'alice' }, 'not-a-key'), env));
  t.throws(() => verifyStorageGrant('', env));
});

test('read-only grant cannot mutate and a move requires both destinations', t => {
  const claims = verifyStorageGrant(sign({ targets: [{ owner: 'alice', prefix: 'chats/a/', actions: ['read'] }] }), env);
  withStorageGrant({ claims }, () => t.throws(() => assertGrantedPath('alice', 'chats/a/file.txt', 'delete')));
  withStorageGrant({ claims: verifyStorageGrant(sign(), env) }, () => {
    t.throws(() => authorizeHandlerOperation({ contextId: 'alice', userId: 'alice', fileScope: 'chat', chatId: 'a',
      blobPath: 'chats/a/file.txt', targetBlobPath: 'global/stolen.txt' }, 'rename'));
    t.throws(() => authorizeHandlerOperation({ contextId: 'alice', userId: 'alice', fileScope: 'chat', chatId: 'a',
      blobPaths: ['chats/a/file.txt', 'chats/b/file.txt'] }, 'delete'));
  });
});

test('concurrent async operations and children retain separate grants', async t => {
  const results = await Promise.all(['alice', 'bob'].map(owner => withStorageGrant({ claims: verifyStorageGrant(sign({
    targets: [{ owner, prefix: '', actions: ['read'] }],
  }, { subject: owner }), env) }, async () => {
    await new Promise(resolve => setImmediate(resolve));
    assertGrantedPath(owner, 'global/a.txt', 'read');
    return scopedProcessingId('job-1');
  })));
  t.not(results[0], results[1]);
});

test.serial('required mode rejects missing grants before invoking the handler', async t => {
  const previous = process.env.CFH_GRANT_MODE;
  process.env.CFH_GRANT_MODE = 'required';
  try {
    const context = {};
    let invoked = false;
    await handleWithStorageGrant(context, { headers: {}, method: 'GET', query: {} }, () => { invoked = true; });
    t.false(invoked); t.is(context.res.status, 401);
  } finally { if (previous === undefined) delete process.env.CFH_GRANT_MODE; else process.env.CFH_GRANT_MODE = previous; }
});

test.serial('audit mode permits every missing grant and emits redacted attribution', async t => {
  const previous = process.env.CFH_GRANT_MODE;
  process.env.CFH_GRANT_MODE = 'audit';
  try {
    const events = [];
    const context = { log: { warn: value => events.push(JSON.parse(value)) } };
    let called = 0;
    const req = { headers: { 'x-cfh-client': 'concierge-web', 'user-agent': 'test-client',
      'x-forwarded-for': '10.0.0.1', authorization: 'secret-key', 'x-request-id': 'trace-1' },
    method: 'DELETE', path: '/api/CortexFileHandler', query: { save: 'false', contextId: 'private-context', blobPath: 'private-filename' } };
    for (let i = 0; i < 3; i++) await handleWithStorageGrant(context, req, () => { called++; });
    t.is(called, 3); t.is(events.length, 3);
    t.like(events[0], { event: 'cfh.storage_grant', outcome: 'missing_allowed', severity: 'warning', operation: 'delete', clientClaim: 'concierge-web' });
    const logged = JSON.stringify(events);
    for (const secret of ['secret-key', 'private-context', 'private-filename']) t.false(logged.includes(secret));
  } finally { if (previous === undefined) delete process.env.CFH_GRANT_MODE; else process.env.CFH_GRANT_MODE = previous; }
});

test.serial('audit mode never downgrades a malformed or empty grant to unsigned', async t => {
  const previous = process.env.CFH_GRANT_MODE;
  process.env.CFH_GRANT_MODE = 'audit';
  try {
    for (const token of ['', 'invalid-token']) {
      const events = [];
      const context = { log: value => events.push(JSON.parse(value)) };
      await handleWithStorageGrant(context, { headers: { 'x-cfh-grant': token }, method: 'GET', query: {} }, () => t.fail('must not run'));
      t.is(context.res.status, 401); t.is(events[0].outcome, 'invalid_denied');
      t.false(JSON.stringify(events).includes('invalid-token'));
    }
  } finally { if (previous === undefined) delete process.env.CFH_GRANT_MODE; else process.env.CFH_GRANT_MODE = previous; }
});

test('future-issued grants are rejected and exact grants cannot list siblings', t => {
  t.throws(() => verifyStorageGrant(sign({ iat: Math.floor(Date.now() / 1000) + 60 }), env));
  const claims = verifyStorageGrant(sign({ targets: [{ owner: 'alice', path: 'articles/one.html', actions: ['read'] }] }), env);
  withStorageGrant({ claims }, () => {
    t.notThrows(() => assertGrantedPath('alice', 'articles/one.html', 'read'));
    t.throws(() => assertGrantedPath('alice', 'articles/two.html', 'read'));
    t.throws(() => assertGrantedPath('alice', 'articles', 'read', { prefix: true }));
  });
});

test.serial('processing requests cannot activate legacy hash lookup with a second flag', async t => {
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  try {
    let observed;
    await handleWithStorageGrant({ log() {} }, {
      headers: { 'x-cfh-grant': sign() }, method: 'GET',
      query: { contextId: 'alice', hash: 'legacy', checkHash: true, uri: 'https://public.test/file.txt', save: true },
    }, (_context, req) => { observed = req.query; });
    t.is(observed.uri, 'https://public.test/file.txt');
    t.falsy(observed.hash); t.falsy(observed.checkHash);
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
