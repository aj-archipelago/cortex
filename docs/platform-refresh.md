# Platform refresh (unreleased)

This update adds assistant directories, sharing and teams; bounded background execution; renewable workspace leases and checkpoint recovery; scoped storage grants and file catalog operations; richer media and transcription controls; configurable weekly cost accounting; search caching; and local MCP access through Concierge Companion.

The model catalog uses public provider routes and operator-supplied credentials. New model definitions omit deployment-specific prices. Set prices in your own configuration before relying on cost estimates. Explicit provider readiness gates remain in place; configured credentials do not prove that a provider model is available to your account.

## Upgrade order

1. Back up the application's database and durable workspace storage. Preserve existing policy anchors, workspace identities and checkpoints.
2. Upgrade the file handler and workspace helper before Cortex. File catalog clients require batch operations; checkpoint recovery requires the matching helper protocol. If using the self-hosted Whisper wrapper, upgrade and drain all workers before enabling Cortex's bounded transcription lifecycle.
3. Configure storage-grant verification on Cortex and the file handler, then configure the Concierge signer. Start with `CFH_GRANT_MODE=audit`, inspect callers, and enable `required` only after all intended callers issue grants. See [storage grants](storage-grants.md).
4. Upgrade Cortex, then Concierge workers and web. Drain existing background work during replacement. Started agent runs are not replayed automatically after uncertain failures.
5. Run `node scripts/migrate-assistant-directory.mjs` with the target `MONGO_URI` to create directory indexes and derived fields. The migration is idempotent. Run Concierge's background and usage index inspectors against the same intended database.

The optional `scripts/workspace-checkpoint-retention.mjs` prints a proposed Azure policy by default. It requires explicit account, resource group and container arguments; `--apply` updates that policy. Review its 14-day history and candidate retention before applying it. It preserves other rules and does not delete committed current checkpoints.

## Configuration changes

| Feature | Configuration |
| --- | --- |
| Weekly allowances | `CORTEX_DEFAULT_WEEKLY_COST_USD`: nonnegative amount or `unlimited`; default unlimited. Set the same default in Concierge. Per-key overrides preserve spend and anchors. |
| Quota storage | `MONGO_URI`, plus `COST_LIMIT_REDIS_URL` or `STORAGE_CONNECTION_STRING`; use one namespace per deployment. |
| Saved file recognition | Set Concierge's build-time `NEXT_PUBLIC_STORAGE_ORIGINS` to exact origins and server-side `CORTEX_STORAGE_CONTAINER_PREFIXES` to the file handler's prefixes. |
| Transcription switching | `TRANSCRIBE_PROVIDER`: `openai` (default), `azure`, `replicate-whisper`, or `replicate-whisperx`. The Azure wrapper uses `WHISPER_TS_API_URL`. |
| Optional transcription | `ENABLE_GEMINI_35_TRANSCRIBE` and `ENABLE_SCRIBE_V2_TRANSCRIBE` enable matching Concierge web/worker routes. |
| Model routes | See `config/default.example.json`; Vertex routes require project/location configuration as well as credentials. |
| Search cache | Opt-in settings are described by `searchCacheEnabled` and related fields in `config.js`; provider storage permission must be configured separately. |
| Local MCP | Configure the standalone relay and both apps as described in [local Companion](local-companion.md). |

Legacy archive search uses optional `CORTEX_NEWS_EN_INDEX` and `CORTEX_NEWS_AR_INDEX` settings with `news_en` and `news_ar` source selectors. Additional logical indexes use the `cognitiveSearchIndexes` configuration map; per-index date field aliases use `cognitiveSearchFieldAliases`. No organization archive is assumed or enabled by default.

The legacy realtime voice helper now reads `CORTEX_URL` and defaults to localhost. Configure an operator endpoint when running it separately.

## Compatibility and validation

Existing public REST APIs, model redirects, local/GCS/Azure storage paths, and user-defined pathways remain supported. The request executor preserves one provider dispatch per attempt. Non-streaming and streaming requests both honor parent cancellation; transcription retries only explicit busy rejections.

Run `npm test` at the root. Validate file handling with `npm run test:gcs` in `helper-apps/cortex-file-handler`, workspace behavior with `npm test` in `helper-apps/cortex-workspace` on Linux, and the realtime gateway with its service-local `npm test`. The Whisper tests and Companion build instructions are linked from their guides.

Cloud credentials, GPU inference, provider availability, signing/notarization, installer hosting, and live upgrades require operator validation. Local test results do not establish those deployment properties.
