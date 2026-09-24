# Storage grants: audit rollout

Concierge signs RS256 bearer grants after authenticating the user and authorizing the selected storage target. Cortex forwards the original grant to CFH. A caller with normal service access can use a valid grant; grants are not bound to a particular calling service.

The first rollout is `CFH_GRANT_MODE=audit` (also the default). Every unsigned request is allowed and produces an unsampled `cfh.storage_grant` warning. Present but invalid, expired or out-of-scope grants are rejected. `required` rejects missing grants as well. Do not turn on `required` until the caller inventory has been reviewed. Production deployment and enforcement remain separate review decisions.

## Configuration

- Concierge web and workers: `CFH_GRANT_PRIVATE_KEY` (RSA PEM), `CFH_GRANT_KEY_ID`, `CFH_GRANT_ISSUER`, `CFH_GRANT_AUDIENCE`.
- Cortex and CFH: `CFH_GRANT_PUBLIC_KEYS` (JSON object mapping key IDs to public PEMs), the same issuer/audience.
- CFH: `CFH_GRANT_MODE=audit`.
- Caller attribution: `CFH_CLIENT_NAME`, normally `cortex`, `concierge-web`, or `concierge-worker`.

Use separate keys and audiences per environment. Keep private keys only in Concierge's secret configuration, never in Cortex, CFH, browser bundles, logs or PRs. For rotation, publish the new public key first, switch the signer, then retain the old public key for at least one grant lifetime. Configure verifiers before enabling the signer.

## Scope and lifetime

The `X-CFH-Grant` JWT contains version 1, subject, issuer, audience, issued/expiry times, and a bounded list of targets. Each target names a logical owner, either an exact `path` or directory `prefix`, and permitted actions (`read`, `list`, `upload`, `rename`, `delete`). CFH maps owners to configured storage; callers cannot select an arbitrary account. Grant lifetimes are at most one hour. Grants contain no context encryption keys.

Cortex captures the grant outside model arguments and restores it for deferred and nested execution. Grant-bearing GraphQL and CFH responses bypass shared response caching. Grants are sent only to the configured CFH endpoint and redirects are disabled. No renewal is implemented: a run lasting beyond an hour must obtain fresh authorization from Concierge.

Media processing, when allowed, uses a temporary namespace derived from the grant subject and a request ID. Scoped GCS inputs must belong to the configured bucket and authorized owner/path. Hash compatibility can resolve only scoped records; it cannot use an unscoped hash map or copy a file into another user's scope.

Short-lived SAS responses are capped by the grant expiry. Existing long-lived URLs persisted by uploads retain their previous lifetime to preserve chat/media rendering. Expiring a grant does not revoke an already issued SAS URL. Audit mode itself does not close unsigned access.

Historical Azure files outside `users/` and `_cfh/` in the configured shared container retain the old read-by-path behavior. A valid scoped read grant can renew a known legacy path even when it predates the scope's folder layout. Exact-object grants remain restricted to that object. This compatibility applies to media, chat attachments, applet/workspace files, previews and downloads through the common handler. It returns a short-lived URL in place; it does not migrate files, authorize shared-root writes/deletes, or relax owner-container and processing-namespace checks. The shared root has no reliable ownership metadata, so legacy compatibility does not promise modern per-owner isolation there.

## Caller inventory

Each missing grant records method, route, operation, client claim, user agent, forwarding/source address, trace/request ID, a context fingerprint, scope and path count. No raw file paths, request bodies, URLs, API keys or grants are recorded in these events. Labels and forwarding headers are attribution hints, not authenticated identities. Correlate unknown labels with deployment revisions, source addresses and request traces before deciding who owns a caller.

Run this query against the CFH Container Apps Log Analytics workspace. Use the dev app for the first rollout:

```kusto
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(1h)
| where ContainerAppName_s == "example-file-handler"
| extend grant = parse_json(Log_s)
| where tostring(grant.event) == "cfh.storage_grant"
| summarize calls=count(), firstSeen=min(TimeGenerated), lastSeen=max(TimeGenerated)
    by outcome=tostring(grant.outcome), caller=tostring(grant.clientClaim),
       source=tostring(grant.sourceAddress), agent=tostring(grant.userAgent),
       operation=tostring(grant.operation), revision=RevisionName_s
| order by outcome asc, calls desc
```

Investigate `missing_allowed` first, especially `unidentified`. Check `invalid_denied`, `scope_denied` and `granted_call_failed` for rollout regressions. Warnings are emitted once per unsigned call without sampling, so even rare callers remain visible. Health checks are excluded because they do not invoke storage handling.

Before enforcement, exercise chat/global uploads, agent file tools, generated media and transcription workers, shared applets, published snapshots and article reads/edits. Confirm both signed success and unsigned attribution, as well as invalid-signature and cross-owner denial. Observe scheduled and infrequent callers for a representative operating cycle.
