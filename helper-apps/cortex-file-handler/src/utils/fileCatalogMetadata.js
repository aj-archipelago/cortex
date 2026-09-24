// Compatibility metadata belongs at the storage boundary. Never join files by
// basename, display name, or a substring: those are search terms, not identity.
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

export function storageIdentity(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${decodeURIComponent(url.pathname)}`;
  } catch { return null; }
}

function blobPathFromUrl(value) {
  try {
    const url = new URL(value);
    const parts = decodeURIComponent(url.pathname).split('/').filter(Boolean);
    if (parts[0] === 'devstoreaccount1') parts.shift();
    return parts.slice(1).join('/') || null;
  } catch { return null; }
}

function timestamp(entry) {
  return Date.parse(entry?.lastAccessed || entry?.timestamp || '') || 0;
}

function addPath(index, key, entry) {
  if (!key) return;
  const existing = index.get(key);
  // A path in two different containers is ambiguous without a cloud URL.
  if (existing === null) return;
  if (existing && storageIdentity(existing.url) !== storageIdentity(entry.url)) {
    index.set(key, null);
  } else if (!existing || timestamp(entry) >= timestamp(existing)) {
    index.set(key, entry);
  }
}

export async function buildFileMetadataIndex(records = {}) {
  const byUrl = new Map();
  const byPath = new Map();
  let count = 0;
  for (const [hash, record] of Object.entries(records)) {
    if (!record || typeof record !== 'object') continue;
    const entry = { ...record, hash };
    const variants = [entry];
    if (record.converted?.url) variants.push({ ...entry, ...record.converted, hash });
    for (const variant of variants) {
      const identity = storageIdentity(variant.url);
      if (identity && (!byUrl.has(identity) || timestamp(variant) >= timestamp(byUrl.get(identity)))) {
        byUrl.set(identity, variant);
      }
      const blobPath = blobPathFromUrl(variant.url) || variant.blobPath || variant.blobName;
      addPath(byPath, blobPath, variant);
    }
    if (++count % 250 === 0) await yieldToEventLoop();
  }
  return { byUrl, byPath };
}

export function findFileMetadata(file, index) {
  const identity = storageIdentity(file.url);
  // A known URL must match exactly; a same-named blob elsewhere is unrelated.
  if (identity) return index.byUrl.get(identity) || null;
  const blobPath = file.blobPath || file.name;
  if (blobPath) return index.byPath.get(blobPath) || null;
  return null;
}

export function metadataFields(record) {
  if (!record) return {};
  record = { ...record, displayFilename: record.displayFilename || record.filename };
  return Object.fromEntries([
    'hash', 'id', 'displayFilename', 'gcs', 'mimeType', 'lastAccessed',
  ].filter(key => record[key] != null).map(key => [key, record[key]]));
}

export async function enrichFileCatalog(files, index) {
  const result = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const metadata = metadataFields(findFileMetadata(file, index));
    result.push({ ...file, ...metadata,
      ...(file.displayFilename ? { displayFilename: file.displayFilename } : {}),
    });
    if ((i + 1) % 250 === 0) await yieldToEventLoop();
  }
  return result;
}
