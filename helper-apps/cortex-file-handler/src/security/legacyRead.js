import { getStorageGrant, grantError, validateGrantPath } from './storageGrant.js';

// Before owner containers, files were read by their opaque path in the shared
// container. Retain that read compatibility without opening current namespaces.
export function isLegacySharedBlobPath(blobPath) {
  validateGrantPath(blobPath);
  return !['users', '_cfh'].some(prefix => blobPath === prefix || blobPath.startsWith(`${prefix}/`));
}

export function assertLegacySharedRead(blobPath, owner = null) {
  const state = getStorageGrant();
  if (!state) return;
  if (state.claims.exp <= Date.now() / 1000) throw grantError('Storage grant expired', 401);
  if (!isLegacySharedBlobPath(blobPath)) throw grantError();
  // Old paths have no folder/owner relationship. A scoped reader may resolve a
  // known old path; exact-object grants still authorize only that exact path.
  if (!state.claims.targets.some(target => (!owner || target.owner === owner)
    && target.actions.includes('read')
    && (target.path !== undefined ? target.path === blobPath : target.prefix !== undefined))) {
    throw grantError();
  }
}
