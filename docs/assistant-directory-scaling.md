# Assistant directory and execution limits

The directory returns 50 summaries by default, with a maximum of 100. Search,
status/access filters, sorting and pagination run in MongoDB. The `get` action
loads one definition by ID, with a fresh permission check. Directory summaries
omit instructions, workspace state, secrets and sharing recipient lists. User
preferences load in one batch per page. `ListAssistants` returns at most 12
summaries, with `nextOffset` for further discovery.

Cortex loads definitions on demand and retains at most 512 in its local cache.
Assistant skills and materials use an indexed deterministic context lookup.

## Migration and rollout

Before deploying the matching Concierge code, run against the intended Cortex DB:

```sh
node scripts/migrate-assistant-directory.mjs
```

Verify `MONGO_URI` points to the intended environment first. The migration creates
directory indexes and backfills `assistantMaterialsContext` in batches of 200.
It can be rerun. It does not change ownership, permissions or uploaded files.
Existing assistant-material access through Concierge requires this backfill.
Deploy Cortex before Concierge web and workers, so the new `get` action and bounded
list parameters are available to callers.

## Execution

Concierge `assistant-run` jobs use a separate Redis admission budget: twelve active
runs across workers, four per user, and four per workflow. Existing digest and
automation budgets remain six global and one per user. The usual worker
concurrency of twenty leaves capacity beyond these background budgets.

Jobs wait through BullMQ delayed admission without using a retry. Deferred new
jobs only touch Redis. Completed turns and turns parked on a question release
capacity. An uncertain failure retains its lease until the fixed 21-minute
lease expires, beyond the 20-minute execution deadline. Redis tokens prevent an
old worker from releasing a newer lease. Admission uses jittered retries, not a
strict FIFO scheduler. Limits live in Concierge's `background-policy.mjs`.

## Validation scope

The isolated MongoDB suite seeds 10,000 definitions and checks paging, literal
search, permissions, projection bounds, preference batching, direct lookup,
cache eviction and migration idempotency. Concierge's isolated Redis suite exercises
1,000 competing admissions, per-user/workflow limits, parked continuations and
failure quarantine. These are correctness and bounded-work checks; they do not
measure provider throughput or establish a production load-test result.
