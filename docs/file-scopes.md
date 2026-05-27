# File Scopes

## Container Rules

- `BASE` = `getDefaultContainerName()`.
- Current owner-scoped Azure container = `BASE-<sanitize(ownerId)>`.
- `sanitize(ownerId)`:
  - lowercases
  - replaces non-`[a-z0-9-]` with `-`
  - collapses repeated `-`
  - trims leading/trailing `-`
  - keeps at most 50 chars of sanitized suffix
- Legacy owner-scoped Azure alias = `BASE-<legacySanitize(ownerId)>`.
- `legacySanitize(ownerId)`:
  - lowercases
  - removes non-`[a-z0-9-]`
  - keeps at most 50 chars of sanitized suffix
- If there is no owner id, Azure uses `BASE` itself.
- `blobPath` below means the path inside the chosen Azure container.
- Redis/FileCollection identity uses the logical context id, not necessarily the physical container owner id.

## Scope Map

| `fileScope` | What it is | Logical context / Redis key | Azure container owner id | Azure blobPath written by this scope |
| --- | --- | --- | --- | --- |
| `all` | Container-root read/list scope. Not a distinct write location. | Same as the selected target; `all` does not create a new logical context. | Whatever owner id the caller selected for the request. | N/A for writes; reads list `/` (container root) |
| `global` | Global files for a user/context. | Usually the user context id. | `contextId \|\| userId` | `global/<filename>` |
| `media` | Direct named folder scope. | Caller-selected context. | `contextId \|\| userId` | `media/<filename>` |
| `chat` | Chat-scoped files. | Usually the user context id, with `chatId` carried separately. | `contextId \|\| userId` | `chats/<chatId>/<filename>`; if `chatId` is missing, it falls back to `global/<filename>` |
| `workspace-user-legacy` | Legacy user-owned workspace/app-private compatibility scope keyed by `workspaceId`. | Usually the user context id, with `workspaceId` carried separately. | `contextId \|\| userId` | `applets/<workspaceId>/<filename>`; if `workspaceId` is missing, it falls back to `global/<filename>` |
| `applet-user` | Current app-private scope. Logical applet+user context, physical user container. | `applet-user:<appletId>:<userId>` | Plain `userId` parsed from the logical context, or explicit `userId` | `applets/<appletId>/<filename>` |
| `applet-shared` | Current app-shared scope. | `applet-shared:<appletId>` | `applet-shared:<appletId>` | `applet-shared/<filename>` |
| `profile` | Direct named folder scope. | Caller-selected context. | `contextId \|\| userId` | `profile/<filename>` |
| `articles` | Direct named folder scope. | Caller-selected context. | `contextId \|\| userId` | `articles/<filename>` |
| `applets` | Direct named folder scope. | Caller-selected context. | `contextId \|\| userId` | `applets/<filename>` |
| `skills` | Direct named folder scope in CFH only. | Caller-selected context. | `contextId \|\| userId` | `skills/<filename>` |
| `workspace-shared-legacy` | Legacy shared workspace artifact scope. | `workspaceId` | `workspaceId` | `/` in the workspace-owned container |

## Generic Compatibility

- Legacy owner-container naming:
  - `listFolder` merges current-container results with legacy-alias-container results.
  - `delete`/`rename`/`setRetention` by `blobPath` falls back to the legacy-alias container if the current container misses.
- Generic default-root blob self-heal:
  - Direct `blobPath` lookup, and `checkHash` when Redis misses but a `blobPath` is present, also probe `BASE` (the unscoped default container root).
  - If a blob is found there, CFH returns it, ensures a fresh GCS backup, and, when the canonical target differs, copies it into the canonical current container/path. Redis metadata is written when a hash was supplied.

## Scope-Specific Compatibility / Migration

- `workspace-user-legacy` has extra legacy compatibility:
  - On `checkHash`, if the current context misses, CFH also probes the old Redis context `workspaceId:userId`.
  - If that old Redis record exists, CFH re-uploads the bytes into the current `workspace-user-legacy` location, writes Redis under the current logical context, and removes the old Redis entry.
  - On blob lookup, CFH also probes the old compound-context Azure container derived from `workspaceId:userId`, then self-heals the blob into the canonical current location.
- `applet-user` does not have a same-scope CFH migration from the older app-private layout.
  - Backward compatibility for old app-private files lives in Cortex `fileAccessPlan` expansion: `kind: app-private` reads both `applet-user` and `workspace-user-legacy` when `workspaceId` is available.
  - Current writes go to `applet-user` when `appletId` is available; otherwise they fall back to `workspace-user-legacy`.
- `applet-shared` and `workspace-shared-legacy` do not have a CFH migration between them.
  - Backward compatibility for old shared app/workspace files lives in Cortex `fileAccessPlan` expansion: `kind: app-shared` reads both `applet-shared` and `workspace-shared-legacy`.
  - Current writes go to `applet-shared` when `appletId` is available; otherwise they fall back to `workspace-shared-legacy`.
- `global`, `media`, `chat`, `profile`, `articles`, `applets`, `skills`, and `workspace-shared-legacy` have no extra scope-specific migration beyond the generic rules above.

## Current `fileAccessPlan` Expansion

| `kind` | Read targets | Write target |
| --- | --- | --- |
| `chat` | `chat` | `chat` |
| `user-global` | `global` | `global` |
| `app-private` | `applet-user`, then `workspace-user-legacy` if `workspaceId` exists | `applet-user` if `appletId` exists, else `workspace-user-legacy` |
| `app-shared` | `applet-shared` container root via `readFileScope=all`, plus `workspace-shared-legacy` container root via `readFileScope=all` if `workspaceId` exists | `applet-shared` if `appletId` exists, else `workspace-shared-legacy` |

## Notes

- `applet-shared` writes into `applet-shared/`, but current `kind: app-shared` reads the whole `applet-shared` container root via `readFileScope=all`.
- `workspace-shared-legacy` reads and writes the workspace-owned container root.
- `skills` exists in CFH path construction, but `lib/fileUtils.js` does not currently expose a `skills` case.
- `media`, `profile`, `articles`, `applets`, and `skills` are direct folder scopes; current `resolveFileAccessTargetCandidates()` does not emit them from `fileAccessPlan` kinds.

## Source of Truth

- `lib/fileUtils.js`
- `helper-apps/cortex-file-handler/src/blobHandler.js`
- `helper-apps/cortex-file-handler/src/index.js`
- `helper-apps/cortex-file-handler/src/utils/legacyWorkspacePrivateResolver.js`
- `helper-apps/cortex-file-handler/src/constants.js`
