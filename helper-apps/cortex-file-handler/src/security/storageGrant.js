import jwt from 'jsonwebtoken';
import { AsyncLocalStorage } from 'node:async_hooks';

const execution = new AsyncLocalStorage();
const ACTIONS = new Set(['list', 'read', 'upload', 'rename', 'delete']);
export const MAX_GRANT_SECONDS = 3600;

export function grantError(message = 'Storage access denied', status = 403) {
  return Object.assign(new Error(message), { status });
}

// Blob names are opaque, case-sensitive paths. Do not decode them into a
// different name while authorizing. URL paths must be decoded once by callers.
export function validateGrantPath(value, { prefix = false } = {}) {
  if (typeof value !== 'string' || value.length > 1024 || value.startsWith('/')
    || /[\\\u0000-\u001f\u007f]/.test(value)
    || value.split('/').some(part => part === '.' || part === '..')
    || (!prefix && !value)) throw grantError('Invalid storage path');
  return value;
}

export function validateGrantClaims(claims) {
  if (claims?.v !== 1 || typeof claims.sub !== 'string' || !claims.sub
    || (claims.processFiles !== undefined && typeof claims.processFiles !== 'boolean')
    || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)
    || claims.iat > Math.floor(Date.now() / 1000) + 5
    || claims.exp <= claims.iat || claims.exp - claims.iat > MAX_GRANT_SECONDS
    || !Array.isArray(claims.targets) || !claims.targets.length || claims.targets.length > 32) {
    throw grantError('Invalid storage grant', 401);
  }
  for (const target of claims.targets) {
    if (!target || typeof target.owner !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(target.owner)
      || !Array.isArray(target.actions) || !target.actions.length || target.actions.some(a => !ACTIONS.has(a))) {
      throw grantError('Invalid storage grant target', 401);
    }
    if (target.path !== undefined) {
      if (target.prefix !== undefined) throw grantError('Ambiguous storage grant target', 401);
      validateGrantPath(target.path);
    } else validateGrantPath(target.prefix, { prefix: true });
    if (target.prefix && !target.prefix.endsWith('/')) throw grantError('Invalid storage grant prefix', 401);
  }
  return claims;
}

export function verifyStorageGrant(token, env = process.env) {
  if (typeof token !== 'string' || !token || token.length > 16384) throw grantError('Storage grant required', 401);
  try {
    const keys = JSON.parse(env.CFH_GRANT_PUBLIC_KEYS || '{}');
    const decoded = jwt.decode(token, { complete: true });
    const kid = decoded?.header?.kid;
    if (decoded?.header?.alg !== 'RS256' || typeof kid !== 'string' || !Object.hasOwn(keys, kid)
      || !env.CFH_GRANT_ISSUER || !env.CFH_GRANT_AUDIENCE) throw new Error('Invalid verifier configuration');
    return validateGrantClaims(jwt.verify(token, keys[kid], {
      algorithms: ['RS256'], issuer: env.CFH_GRANT_ISSUER, audience: env.CFH_GRANT_AUDIENCE,
      clockTolerance: 5, maxAge: MAX_GRANT_SECONDS,
    }));
  } catch { throw grantError('Invalid or expired storage grant', 401); }
}

export function getStorageGrant() { return execution.getStore() || null; }
export function withStorageGrant(state, callback) { return execution.run(state, callback); }

export function assertGrantedPath(owner, path, action, { prefix = false } = {}) {
  const state = getStorageGrant();
  if (!state) return; // Audit mode permits unsigned requests.
  validateGrantPath(path, { prefix });
  if (state.claims.exp <= Date.now() / 1000) throw grantError('Storage grant expired', 401);
  const authorized = state.claims.targets.some(target => target.owner === owner && target.actions.includes(action)
    && (target.path !== undefined ? !prefix && path === target.path
      : (!target.prefix || path.startsWith(target.prefix) || (prefix && `${path.replace(/\/$/, '')}/` === target.prefix))));
  if (!authorized) throw grantError();
}

export function limitGrantExpiry(expiry) {
  const state = getStorageGrant();
  if (!state) return expiry;
  const deadline = new Date(state.claims.exp * 1000);
  if (deadline <= new Date()) throw grantError('Storage grant expired', 401);
  return expiry < deadline ? expiry : deadline;
}
