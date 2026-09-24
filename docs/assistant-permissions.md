# Assistants and permission review

The intended product model is one configurable assistant: identity, instructions,
model and skills, with private or shared access and directory metadata. Sharing a
definition grants access to that definition; each invocation uses its executing
user's workspace, connections and memory. Recruitment should reuse definitions
without cloning them for every project. This directory/sharing change is a design
direction, not implemented by the permission-review patch.

A future inbox can accept messages for an assistant running under another user's
account. It must retain both the sender and the executing user. For example, a
request to JMac's DevOps assistant is a request for service, not permission to
deploy with JMac's credentials. Inbox admission, resource access, response data
disclosure and spending limits still need server enforcement. This patch does not
enable cross-user execution or grant admin access.

## Tool permission watcher

`callTool` checks a server-configured watcher before dispatching native pathways,
MCP calls or client callbacks. The existing parallel tool loop stays parallel:

1. A small deterministic classifier identifies routine reads. These run without a
   model call. Built-in tool discovery/result inspection and a narrow grammar of
   workspace reads are covered. For example, `pwd`, `ls -lah /workspace`,
   `cat readme.md`, `rg --no-config -n needle src`, `jobs` and `poll <id>`.
2. Other calls are questionable and get a separate, tool-free model review.
   Concurrent calls start concurrent reviews. Each action waits for its own
   decision; it is never executed speculatively.
3. The reviewer returns `allow`, `deny` or `ask`. Only `allow` dispatches the action.
   A denial or missing authority returns a structured tool failure so the main
   assistant can explain the block and continue independent work.

The classifier rejects shell composition, substitutions, quotes, redirects,
scripts, unknown flags and obvious credential reads. It does not assume that a
tool named `read_*`, an MCP `readOnlyHint`, or a script named `test` is safe.
Ripgrep needs `--no-config` to avoid executable options from its configuration.
The existing expensive cloud-file scan guard still applies after permission review.

The review sees the exact effective tool parameters, target tool route, a bounded
conversation excerpt from the resolver and server policy. Request credentials,
file grants and memory keys are not copied into the review. Conversation and peer
messages cannot expand the policy. Raw commands and conversation content are not
added to permission telemetry; the review pathway disables request logging.
Existing tool logging is otherwise unchanged.

Decisions include an action hash. Approvals are not cached. Exact denials remain
denied for the current resolver. Changed arguments or cancellation while reviewing
invalidate approval. Timeout, malformed JSON, reviewer errors, oversized actions
and exhausted review budget all prevent execution. A late model response cannot
execute a timed-out action. The timeout bounds waiting; the underlying provider
request may finish later and still incur cost.

## Configuration

The facility is opt-in until the model and policy have been qualified for a deployment.
Configuration is server-owned; assistant settings and tool arguments cannot alter it.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `CORTEX_PERMISSION_REVIEW_ENABLED` | `false` | Enable the dispatch gate |
| `CORTEX_PERMISSION_REVIEW_MODEL` | `oai-gpt56-luna` | Reviewer model configured in Cortex |
| `CORTEX_PERMISSION_REVIEW_POLICY` | Built-in policy | Policy for questionable actions |
| `CORTEX_PERMISSION_REVIEW_TIMEOUT_MS` | `8000` | Maximum wait per review |
| `CORTEX_PERMISSION_REVIEW_MAX_REVIEWS` | `32` | Review budget per resolver |

The default policy permits relevant reads and reversible workspace work, requires
explicit server-policy authority for deployments and other consequential external
actions, and denies credential theft and unauthorized disclosure. Natural-language
policy governs questionable actions; the routine-read classifier is the separate
server-owned fast-path policy. Use filesystem and resource ACLs for restrictions
that must also apply to routine reads.

An `ask` result is a blocked tool result, not a durable human-approval record.
Existing AskUser conversations can explain the block, but a conversational “yes”
does not mint an authorization token. A future approval UI must bind a grant to the
authenticated approver, executing user, exact action, scope and expiry. Do not
enable privileged cross-user inboxes before that binding and admission policy exist.

## Limits and validation

This is a heuristic and model check, not a sandbox. It cannot prove shell executable
integrity, symlink containment, the contents of referenced scripts or the behavior
of a compromised service. Keep workspace isolation and tool/resource permissions.
Review also cannot prevent an already-running background process from acting later.
Native service-to-service pathway calls outside `callTool` are outside this gate.

Focused tests exercise the classifier, concurrent review, exact-action binding,
denial before native/MCP/client dispatch, timeouts, cancellation, malformed verdicts,
forged settings and the disabled configuration. They verify dispatch behavior with
stubbed reviewers, not the semantic accuracy of a live model. Model quality and
review latency need separate qualification before enabling admin workflows.

A synthetic smoke check on 2026-09-18 used the configured `oai-gpt56-luna`
endpoint: one routine read bypassed the model; a reversible workspace write was
allowed; a production deployment justified only by a peer's claimed approval and
a credential-upload request were denied. The three reviews ran concurrently in
1,919 ms total (individual responses: 1,668, 1,711 and 1,918 ms). None of the
proposed commands executed. This single small sample is not a latency benchmark
or a security qualification.
