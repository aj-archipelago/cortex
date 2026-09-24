import { assertGrantedStorageUrl } from '../security/grantRequest.js';
import { storageIdentity } from './fileCatalogMetadata.js';

// Path deletion and hash deletion must share the same lifecycle: establish the
// physical blob first, delete its backups, then retire only its own metadata.
export async function deleteCatalogFile({ clients, containerOwnerId, records, entries: matchedEntries, storageService, removeRecord, saveRecord }) {
  let selected;
  for (const client of clients) {
    if (await client.exists()) { selected = client; break; }
  }
  const refersTo = (record, url) => Boolean(storageIdentity(record?.url)) && storageIdentity(record?.url) === storageIdentity(url);
  const entries = (matchedEntries || Object.entries(records || {})).filter(([, record]) => record && typeof record === 'object');
  // A retry after primary deletion still needs the retained backup pointers.
  selected ||= clients.find(client => entries.some(([, record]) =>
    refersTo(record, client.url) || refersTo(record.converted, client.url)));
  if (!selected) return { found: false };
  assertGrantedStorageUrl(selected.url, "delete");

  const matches = entries.filter(([, record]) =>
    refersTo(record, selected.url) || refersTo(record.converted, selected.url));

  const backupUrls = new Set();
  for (const [, record] of matches) {
    for (const variant of [record, record.converted]) {
      if (refersTo(variant, selected.url) && variant.gcs) backupUrls.add(variant.gcs);
    }
  }
  const backup = await storageService.getBackupProvider();
  if (backup) {
    const expected = storageService._getExpectedGCSBlobName({ url: selected.url, containerOwnerId });
    if (expected) backupUrls.add(backup.buildUrlForBlobName
      ? backup.buildUrlForBlobName(expected) : `gs://${backup.bucketName}/${expected}`);
  }
  if (backupUrls.size && !backup) throw new Error('Backup storage unavailable; metadata retained for retry');
  // Delete backups first so even a hashless file remains an addressable retry
  // target if backup deletion fails. Metadata is retired only after both steps.
  for (const url of backupUrls) assertGrantedStorageUrl(url, "delete");
  for (const url of backupUrls) await storageService.deleteFileFromBackup(url);
  await selected.deleteIfExists();

  for (const [hash, record] of matches) {
    if (refersTo(record, selected.url)) {
      // The original record may still be needed by a separately stored conversion.
      if (record.converted?.url && !refersTo(record.converted, selected.url)) {
        const { url, gcs, converted, ...metadata } = record;
        await saveRecord(hash, { ...metadata, ...converted });
      } else {
        await removeRecord(hash);
      }
    } else {
      const { converted, ...remaining } = record;
      await saveRecord(hash, remaining);
    }
  }
  return { found: true };
}

// One paged legacy scan for a whole selection. No cross-request cache or second
// persistent catalog: current cloud locations remain the identifiers.
export async function deleteCatalogFiles({ items, scanRecords, commitRecord, ...options }) {
  const byUrl = new Map();
  for (const { clients } of items) {
    for (const client of clients) byUrl.set(storageIdentity(client.url), new Set());
  }
  const records = new Map();
  let bytes = 0;
  for await (const [key, record, raw] of scanRecords()) {
    const identities = new Set([storageIdentity(record.url), storageIdentity(record.converted?.url)]);
    if (![...identities].some(identity => identity && byUrl.has(identity))) continue;
    if (!records.has(key)) bytes += Buffer.byteLength(raw);
    if (bytes > 16 * 1024 * 1024) throw new Error('Legacy deletion metadata exceeds safety limit');
    records.set(key, { record, raw });
    for (const identity of identities) if (identity) byUrl.get(identity)?.add(key);
  }
  const results = [];
  // Sequential mutations also preserve original/converted pairs in one batch.
  // A compare-and-set protects their metadata from concurrent requests/writers.
  for (const { blobPath, clients } of items) {
    try {
      const keys = new Set(clients.flatMap(client => [...(byUrl.get(storageIdentity(client.url)) || [])]));
      const entries = [...keys].filter(key => records.has(key)).map(key => [key, records.get(key).record]);
      const commit = async (key, replacement) => {
        await commitRecord(key, records.get(key).raw, replacement);
        if (replacement) records.set(key, { record: replacement, raw: JSON.stringify(replacement) });
        else records.delete(key);
      };
      const result = await deleteCatalogFile({ ...options, clients, entries,
        removeRecord: key => commit(key, null), saveRecord: commit });
      results.push({ blobPath, deleted: result.found, status: result.found ? 200 : 404 });
    } catch {
      results.push({ blobPath, deleted: false, status: 500 });
    }
  }
  return results;
}
