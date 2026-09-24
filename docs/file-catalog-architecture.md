# Cloud file catalog and legacy compatibility

Files are identified by their scoped cloud location. Identical content in two locations is two files. A display name is a label, and a content checksum is not a file identifier.

## Current architecture

- Cloud storage establishes existence, path, size, content type and modification time. Access plans establish read/write permission separately.
- CFH stores original upload names as UTF-8/base64 blob metadata, reads them with cloud properties, and updates them on physical renames. Folder moves preserve the display name. Converted uploads use the original's scoped container and keep the original display name while retaining their actual content type.
- CFH owns compatibility metadata attachment. Old records are matched by exact cloud URL, including container and case-sensitive path; tokens are ignored. Basename and substring joins are forbidden. A transient index is built once per legacy catalog and yields every 250 entries. It is not another persistent catalog.
- Cortex consumes CFH results without loading or reconciling Redis metadata. Catalog identity/deduplication is context plus path, never hash. Name search remains a user convenience; explicit path misses do not search for a different file.
- FileCollection SEARCH and LIST use compact cloud listings. Original-name metadata is included in that response. LIST sorts before selecting results, then obtains links for at most the requested result count with four concurrent requests. Link generation skips backup creation and redundant metadata lookup. A missing search result does not trigger a full listing on the new CFH protocol.
- Compact scans are bounded at 50,000 entries per access target. Truncation is reported; counts and ordering describe the scanned subset. Prefixes narrow the scan. This is not an indexed global newest-file query.
- FileCollection REMOVE resolves the authorized location, deletes that location and its backups, and reports confirmed successes. Backup deletion precedes primary deletion so a hashless file remains available for retry on backup failure. Legacy pointers are retired only after both succeed. Conversions sharing a legacy record retain the surviving object's pointer.

## Differential audit

| Previous machinery | Current consumers / reason | Decision |
| --- | --- | --- |
| Cortex cloud x Redis fuzzy reconciliation | LIST; unsuccessful search; missing display name during exact resolve | Removed. CFH already owns file metadata; this was the demonstrated quadratic CPU path. |
| CFH basename-only Redis join | Full cloud listing, including Concierge Files UI | Replaced with exact location matching. Different folders/containers must not share labels or identities. |
| Redis original names / generated-media labels | Historical opaque upload names, converted documents, legacy metadata APIs | Retained as a sparse compatibility source. Native blob metadata handles new uploads; already-uploaded generated media no longer creates a second Cortex collection record. |
| Hash upload deduplication | Cortex upload helper, Concierge browser upload helper and streaming server upload handler; CFH scoped remote import | Removed from those active upload paths. Content equality must not redirect the requested destination. |
| Hash fallback after path failure | Concierge rename/delete helpers; saved-media renewal in transcription and automation | Removed for mutations. Legacy reads may still renew historical hash-bearing records after a move; new uploads do not create those references. |
| Legacy hash endpoints and stored links | Old saved chats, media records, external CFH callers | Retained for compatibility. Not used as new catalog identity. |
| Redis backup/conversion pointers | Old GCS locations, original/converted pairs, deletion retry and old hash resolution | Retained. Deleting the store wholesale would lose recovery information. Modern backup paths derive from scoped cloud location. |
| Legacy Azure containers and old workspace/app scope aliases | Existing files and shared app/workspace access plans | Retained. Access expansion and current-container precedence remain in place. |
| `loadFileCollection` / `saveFileCollection`, legacy metadata mutation API | Exported compatibility surface; no current Concierge GraphQL callers found for `sys_read_file_collection` / `sys_update_file_metadata` | Kept outside routine discovery. Source absence does not prove absence of external API clients. |
| Unexported workspace sync functions and Redis `WorkspaceManifest` writer | No callers or exports; current WorkspaceSSH uses its own location-based file sync | Removed the dead sync-in/sync-out implementation and its private download helpers. |
| Version/content checksums in Concierge | Applet versions and change detection | Retained as checksums; server uploads no longer send them as CFH identity. |
| Concierge Files folder tree and legacy message attachments | Full-tree navigation, saved chat files, metadata from application records | Preserved. Its existing full-list endpoint is linear; introducing UI pagination requires a separate UX change. |
| Default-container conversion writes | New scoped uploads still passed through an unscoped conversion helper | Corrected for new uploads; legacy conversion APIs remain compatible. |

## Validation and rollout

Focused Cortex tests cover scoped identity, successful/failed direct lookups, original-name compatibility, result selection before signing, bounded concurrency, hashless removal, failed deletion counts, and read-only grants. CFH emulator tests cover native/legacy metadata, international names, conversion location, physical rename, backup cleanup, retries and scope rejection. The large-catalog test uses 30,000 unmatched files and 15,000 metadata records, requires event-loop yields and a bounded runtime.

Deploy CFH first, then Cortex, then Concierge. CFH is a separate Container App deployment; the Cortex Web App deploy does not update it. The Cortex client tolerates older CFH instances during rolling deployment without reinstating the removed Redis join. Use synthetic locations for write canaries and preserve the previous revisions for rollback. There is no bulk metadata migration or destructive Redis cleanup.

The unit tests exercise large synthetic catalogs and verify that the compatibility pass builds lookup indexes once. Storage/network time and cloud throughput require separate deployment testing.

## Bulk deletion correction

Browser selections and FileCollection REMOVE group exact locations by authorized scope and send at most 500 paths per request. Groups and batches execute sequentially. CFH validates every path before mutation, then reads legacy records with HSCAN (COUNT 128), yielding between pages and retaining only records matching the requested URLs. Duplicate records contribute all backup pointers. A batch costs O(M + K + matching records), instead of K separate full scans over M records. There is no persistent secondary catalog or cache invalidation protocol.

This remains a compatibility scan per scope/batch, including a single-file request. It is not an indexed constant-time legacy lookup. More than 100,000 scanned entries or 16 MiB of matching metadata aborts before deleting anything; Redis errors or invalid metadata also abort. Those limits protect the service but may require a separate migration for unusually large legacy stores. Full browser listing and metadata enrichment retain the previously documented linear costs.

Backup deletion precedes primary deletion. Metadata retirement uses an atomic compare-and-set against the scanned value, so a concurrent change cannot be overwritten. A conflict reports failure and retains the changed record for retry. Original/converted pairs update the shared batch state after each mutation. Per-file outcomes distinguish success, missing files, and incomplete deletion. Browser placeholders follow confirmed deletion; partial failures restore failed files and retain successful removals. An interrupted response can leave completed deletions unconfirmed in the UI until refresh; retries do not fall back to a deprecated hash.

Deploy the updated CFH before enabling the updated clients: older handlers do not implement batch deletion.
