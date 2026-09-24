import { createHash } from 'node:crypto';
import { getDefaultContainerName, getUserContainerNameCandidates, GCS_BUCKETNAME } from '../constants.js';
import { constructFolderPath, sanitizeSubPath, getScopedContainerOwnerId } from '../blobHandler.js';
import { getFileStoreMap } from '../redis.js';
import { logGrantAudit } from './grantAudit.js';
import { assertLegacySharedRead, isLegacySharedBlobPath } from './legacyRead.js';
import { assertGrantedPath, getStorageGrant, grantError, validateGrantPath,
  verifyStorageGrant, withStorageGrant } from './storageGrant.js';

export function processingPrefix() {
  const state = getStorageGrant();
  if (state?.claims.exp <= Date.now() / 1000) throw grantError('Storage grant expired', 401);
  if (!state?.claims.processFiles) throw grantError('Media processing is not authorized');
  return `_cfh/${createHash('sha256').update(state.claims.sub).digest('hex')}/`;
}

export function scopedProcessingId(requestId) {
  if (!getStorageGrant()) return requestId;
  if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(requestId)) throw grantError('Invalid processing request ID');
  return `${processingPrefix()}${requestId}`;
}

export function assertGrantedStorageUrl(value, action = 'read') {
  if (!getStorageGrant()) return;
  let url;
  try { url = new URL(value); } catch { throw grantError('Invalid storage URL'); }
  const state = getStorageGrant();
  if (state.claims.exp <= Date.now() / 1000) throw grantError('Storage grant expired', 401);
  if (url.protocol === 'gs:') {
    if (url.hostname !== GCS_BUCKETNAME) throw grantError('Storage URL is outside the configured bucket');
    const blobPath = decodeURIComponent(url.pathname.slice(1));
    validateGrantPath(blobPath);
    if (state.claims.processFiles && blobPath.startsWith(processingPrefix())) return;
    for (const target of state.claims.targets) {
      if (blobPath.startsWith(`${target.owner}/`)) {
        try { assertGrantedPath(target.owner, blobPath.slice(target.owner.length + 1), action); return; } catch { /* Try the next target. */ }
      }
    }
    throw grantError();
  }
  const account = process.env.AZURE_STORAGE_CONNECTION_STRING?.match(/(?:^|;)AccountName=([^;]+)/)?.[1];
  const emulator = url.pathname.startsWith('/devstoreaccount1/');
  if (!(emulator && process.env.NODE_ENV === 'test') && url.hostname !== `${account}.blob.core.windows.net`) throw grantError('Storage URL is outside the configured account');
  const parts = url.pathname.split('/').slice(emulator ? 2 : 1);
  const container = parts.shift();
  const blobPath = decodeURIComponent(parts.join('/'));
  validateGrantPath(blobPath);
  if (container === getDefaultContainerName() && state.claims.processFiles && blobPath.startsWith(processingPrefix())) return;
  for (const target of state.claims.targets) {
    if (getUserContainerNameCandidates(getDefaultContainerName(), target.owner).includes(container)) {
      try { assertGrantedPath(target.owner, blobPath, action); return; } catch { /* Try another authorized target. */ }
    }
    // Historical shared-container files have an explicit owner prefix.
    if (container === getDefaultContainerName() && blobPath.startsWith(`users/${target.owner}/`)) {
      assertGrantedPath(target.owner, blobPath.slice(`users/${target.owner}/`.length), action);
      return;
    }
  }
  if (action === 'read' && container === getDefaultContainerName() && isLegacySharedBlobPath(blobPath)) {
    assertLegacySharedRead(blobPath);
    return;
  }
  throw grantError();
}

export function authorizeHandlerOperation(source, operation) {
  if (!getStorageGrant()) return;
  const owner = getScopedContainerOwnerId(source);
  const folder = constructFolderPath(source);
  const action = operation === 'delete' || operation === 'clearHash' ? 'delete'
    : operation === 'rename' ? 'rename' : operation === 'listNames' || operation === 'listFolder' ? 'list'
      : operation === 'remoteFile' || operation === 'save' || operation === 'upload' ? 'upload' : 'read';
  if (source.uri) processingPrefix();
  for (const input of [source.uri, source.fetch, source.load, source.restore].filter(Boolean)) {
    let url;
    try { url = new URL(input); } catch { throw grantError('Invalid source URL', 400); }
    const account = process.env.AZURE_STORAGE_CONNECTION_STRING?.match(/(?:^|;)AccountName=([^;]+)/)?.[1];
    if (url.protocol === 'gs:' || url.hostname === `${account}.blob.core.windows.net`
      || url.pathname.startsWith('/devstoreaccount1/')) assertGrantedStorageUrl(input);
  }
  if (source.requestId && operation === 'delete' && !source.blobPath && !source.blobPaths && !source.hash) {
    scopedProcessingId(source.requestId); return;
  }
  if (operation === 'media_chunking' || operation === 'document_processing' || (operation === 'save' && source.uri)) return;
  if (operation === 'upload') return; // Multipart destinations are checked before each upload starts.
  const paths = source.blobPaths || (source.blobPath ? [source.blobPath] : null);
  if (paths) {
    if (!Array.isArray(paths) || !paths.length || paths.length > 500) throw grantError('Invalid storage path batch');
    for (const path of paths) assertGrantedPath(owner, path, action);
    if (operation === 'rename') {
      const original = source.blobPath;
      const target = source.targetBlobPath || `${original.slice(0, original.lastIndexOf('/') + 1)}${source.newFilename}`;
      assertGrantedPath(owner, target, 'rename');
    }
  } else {
    if (folder === null) throw grantError('Storage scope is required');
    let prefix = folder;
    if (source.subPath) {
      const sub = sanitizeSubPath(source.subPath);
      if (!sub) throw grantError('Invalid storage subpath');
      prefix = prefix ? `${prefix}/${sub}` : sub;
    }
    assertGrantedPath(owner, prefix, action, { prefix: true });
  }
}

export async function handleWithStorageGrant(context, req, handler) {
  try {
    const token = req.headers?.['x-cfh-grant'] ?? req.headers?.get?.('x-cfh-grant');
    if (token == null) {
      const auditing = ['audit', 'optional'].includes(process.env.CFH_GRANT_MODE || 'audit');
      logGrantAudit(context, req, auditing ? 'missing_allowed' : 'missing_denied');
      if (auditing) return await withStorageGrant(null, () => handler(context, req));
    }
    let claims;
    try { claims = verifyStorageGrant(token); }
    catch (error) { if (token != null) logGrantAudit(context, req, 'invalid_denied', error.message); throw error; }
    logGrantAudit(context, req, 'valid');
    return await withStorageGrant({ token, claims }, async () => {
      let body = req.body;
      if (typeof body === 'string' && body) { try { body = JSON.parse(body); } catch { throw grantError('Invalid JSON body', 400); } }
      const bodySource = body?.params || body || {};
      const source = req.method?.toUpperCase() === 'GET' ? { ...bodySource, ...req.query } : { ...req.query, ...bodySource };
      // Under grants, legacy hashes resolve only in an explicitly scoped map,
      // and the actual URL must fit the grant. They cannot trigger old lazy
      // migration, cross-folder copies or unscoped hash fallback.
      if (source.hash && !source.blobPath && !source.blobPaths && !source.uri && !source.fetch && !source.load && !source.restore && !(source.save === true || source.save === 'true')) {
        const contextId = source.contextId || source.userId;
        if (!contextId) throw grantError('Scoped location required for legacy reference');
        const record = await getFileStoreMap(source.hash, true, contextId);
        if (!record?.url) throw grantError('File not found', 404);
        const action = req.method?.toUpperCase() === 'DELETE' || source.operation === 'delete' ? 'delete' : source.rename ? 'rename' : 'read';
        assertGrantedStorageUrl(record.url, action);
        const url = new URL(record.url);
        const parts = url.pathname.split('/').slice(url.pathname.startsWith('/devstoreaccount1/') ? 3 : 2);
        const blobPath = decodeURIComponent(parts.join('/'));
        const cleaned = { ...source, blobPath, includeMetadata: false, ensureBackup: false };
        delete cleaned.hash; delete cleaned.checkHash; delete cleaned.clearHash;
        // Exact locations are authoritative even when a hash was also supplied.
        req = { ...req, query: cleaned, body: req.method?.toUpperCase() === 'GET' ? undefined : cleaned };
      } else if (source.blobPath || source.blobPaths || source.hash) {
        const cleaned = { ...source };
        delete cleaned.hash; delete cleaned.checkHash; delete cleaned.clearHash;
        req = { ...req, query: cleaned, body: req.method?.toUpperCase() === 'GET' ? undefined : cleaned };
      }
      const result = await handler(context, req);
      if (context.res?.status >= 400) logGrantAudit(context, req, 'granted_call_failed', `HTTP ${context.res.status}`);
      return result;
    });
  } catch (error) {
    if (error.status === 403) logGrantAudit(context, req, 'scope_denied', 'Storage scope or operation denied');
    if (!error.status) throw error;
    context.res = { status: error.status, body: error.message };
  }
}
