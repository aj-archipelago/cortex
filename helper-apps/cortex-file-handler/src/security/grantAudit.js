import { createHash } from 'node:crypto';

const bounded = value => typeof value === 'string' ? value.replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 160) : null;
const fingerprint = value => typeof value === 'string' && value
  ? createHash('sha256').update(value).digest('hex').slice(0, 16) : null;

export function logGrantAudit(context, req, outcome, reason = null) {
  const header = name => req.headers?.[name] || req.headers?.get?.(name);
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const params = body?.params || body || {};
  const source = req.method?.toUpperCase() === 'GET' ? { ...params, ...req.query } : { ...req.query, ...params };
  const enabled = value => value === true || value === 'true';
  const operation = enabled(source.save) ? 'save' : enabled(source.checkHash) ? 'checkHash'
    : enabled(source.clearHash) ? 'clearHash' : enabled(source.rename) || source.operation === 'rename' ? 'rename'
      : enabled(source.listNames) || source.operation === 'listNames' ? 'listNames'
        : enabled(source.listFolder) || source.operation === 'listFolder' ? 'listFolder'
          : source.fetch || source.load || source.restore ? 'remoteFile'
            : req.method?.toUpperCase() === 'DELETE' || source.operation === 'delete' ? 'delete'
              : source.uri ? 'processing' : source.blobPath ? 'blobLookup' : source.hash ? 'hashLookup' : 'upload';
  const record = {
    event: 'cfh.storage_grant', severity: outcome === 'valid' ? 'info' : 'warning', outcome,
    mode: process.env.CFH_GRANT_MODE || 'audit', reason,
    serviceRevision: bounded(process.env.CONTAINER_APP_REVISION),
    // Labels and forwarding headers are attribution hints, not authentication.
    clientClaim: bounded(header('x-cfh-client')) || 'unidentified',
    userAgent: bounded(header('user-agent')),
    sourceAddress: bounded(header('x-forwarded-for') || req.socket?.remoteAddress),
    requestId: bounded(header('x-request-id') || header('traceparent')),
    method: bounded(req.method), route: bounded(req.path), operation,
    contextFingerprint: fingerprint(source.contextId || source.userId),
    fileScope: bounded(source.fileScope), pathCount: Array.isArray(source.blobPaths) ? source.blobPaths.length : source.blobPath ? 1 : 0,
    multipart: String(header('content-type') || '').startsWith('multipart/'),
  };
  // Deliberately no raw paths, URLs, tokens, request bodies or API keys.
  const level = outcome === 'valid' ? 'info' : 'warn';
  if (typeof context.log?.[level] === 'function') context.log[level](JSON.stringify(record));
  else if (typeof context.log === 'function') context.log(JSON.stringify(record));
  else console[level](JSON.stringify(record));
}
