# Colleagues

Assistants are reusable Cortex entity definitions authored by one Concierge user and optionally shared. Automations remain the task and scheduling layer: `Automation.entityId` optionally selects a colleague; unset records retain their existing personal-assistant behavior. This preserves run history, HTML outputs, supporting files, sharing, and home widgets without migrating or copying automation records.

## Ownership and execution

Cortex stores `kind: colleague`, `colleagueOwnerId`, `colleagueStatus`, and `workspaceOwnerId` with the existing entity. Authors manage name, description, instructions, portrait, default model and attached materials; only owners manage sharing and lifecycle. The owner and personal workspace binding come from server-side personal-entity resolution. Colleagues have no `personalOwnerId` and are excluded from personal-entity candidate selection. Listing and execution verify the user association; an archived or inaccessible colleague cannot silently fall back to a personal assistant.

Each colleague uses the ordinary entity agent, tools, model selection, memory, MCP configuration, and chat streaming. Scheduled execution revalidates the colleague against the automation owner's context at dispatch. Pausing prevents new task runs; chat and existing runs remain available. Archiving retains all records and files.

## Shared workspace

All workspace requests, uploads, and downloads resolve the colleague to its validated personal workspace owner. Only that personal entity holds runtime state, container credentials, provisioning locks, activity tracking, reaper state, and checkpoints. Shell calls start in `/workspace/colleagues/<stable hash of entity id>`. These directories are organizational: colleagues of one user share the filesystem, environment, installed packages, and capacity. This does not provide isolation between that user's colleagues. Reset and secret-management commands remain on the personal entity. No existing personal containers or checkpoints are migrated.

## Tasks and watches

The BullMQ automation scheduler retains its atomic claims and active-run checks. Scheduled and manual tasks use the assigned entity. File triggers inspect a selected `/workspace` input folder once per scheduler tick (about a minute), using a bounded metadata fingerprint, without provisioning or recording activity. A first observation establishes a baseline. A changed fingerprint must remain stable across two checks before enqueueing. The committed fingerprint advances after enqueue succeeds; queue failure restores the due time. Idle workspaces are skipped. Monitoring resumes when the user next starts their workspace.

The watcher excludes hidden files, symlinks, dependency folders and cloud mounts, and rejects folders above 5,000 files. Outputs should go outside the input folder. This first implementation watches local workspace folders, not cloud-storage uploads or a kernel event stream. It does not promise exactly-once execution: BullMQ retries and external side effects still require idempotent task instructions. Paired service rollout and worker checks are required before users enable new tasks.

## Inbox and chat

`NotifyUser` is available to personal assistants, created colleagues, and shared specialists, including entities with explicit legacy tool lists. For Concierge runs, it uses the existing user/entity capability gateway and waits for durable inbox and encrypted chat delivery before reporting success. The gateway derives a stable delivery ID from the capability and tool call for retries. Cortex calls without a Concierge capability use the durable outbox and explicitly report queued delivery instead. Shared entities notify only that user, never their author or all associated users; internal system entities and archived or inaccessible entities cannot send. Concierge's existing scheduler consumes fallback outbox messages. Chat completion refreshes the inbox immediately; background updates use the existing inbox polling. Source-derived notification IDs and message dedupe keys make retry delivery idempotent. Delivery selects a private conversation and checks sharing again on retries. The notification retains the chosen chat ID, so a retry after interruption stays in that thread. Acknowledgement occurs only after durable delivery. Each inbox card shows the sender's Wisp, name, message, and time, with no task completion label. The optional `url` tool argument links to a relative app path or an absolute HTTP(S) destination; invalid schemes, credentials, control characters, and protocol-relative paths are rejected. Without a destination, the whole card opens the companion chat. Help messages state the missing decision or input; users reply through normal chat and can rerun the task. Ordinary automation completion/failure entries remain in the inbox even if the agent does not send an extra message.

The Cortex delivery pathway is service-to-service on the existing internal Cortex endpoint. It is not proxied to a browser route. It shares the same deployment/network trust boundary as other internal system pathways.

## Paired rollout

Web may be staged operator-only for gateway canaries; public access waits for assignment-aware workers and old-revision retirement.

1. Validate and deploy Cortex first, including the new pathways and entity persistence fields.
2. Deploy Concierge workers with assignment-aware execution and outbox delivery.
3. Deploy Concierge web. Do not expose colleague task creation while old workers can claim those tasks: an older worker ignores `entityId` and uses the personal assistant.
4. Canary with two synthetic colleagues under one test user. Verify distinct chat identities and directories, the same owner container ID, cross-user denial, a manual run, a scheduled run, a stable folder change, a help message, and notification replay after an interrupted acknowledgement. Verify pause/archive before wider access.

Rollback web access first. Pause colleague-assigned automations before rolling workers back; retain Cortex fields, outbox entries, chats, and files. No data-destructive migration is necessary.


## Entity options and memory separation

The directory now includes the owner's personal entity first, created colleagues next, and accessible shared entities. The shared system default is represented by the personal entity. Personal entities cannot be paused or archived; shared identities remain owner-managed. All can be selected for chat and assigned tasks; file watching uses the executing user's personal workspace.

Execution preferences are stored per `(user context, entity id)` in the existing Mongo database's `<entityCollection>_user_preferences` collection. Model, reasoning effort, and memory-learning choices are resolved on each agent run in Cortex. Model choices are validated against agentic models and groups. Personal preferences also update the legacy Concierge user defaults for existing callers. Other entities fall back to the application default model. Selecting a model from the footer saves it for the active Colleagues card or chat entity; other screens use the personal entity.

Personal memory retains its existing user context address. Every other entity uses a deterministic memory address derived from both user and entity ID, with the existing user's encryption key. This applies to prompt memory, remembered context, searches, automatic learning, and StoreMemory. Model-provided tool arguments cannot replace the bound memory address or owner/file context. File tooling retains its original user context and shared workspace binding. Memory learning disabled also blocks StoreMemory writes; reading existing memories remains enabled. Entity-level `useMemory: false` remains a hard disable.

No old memory is copied, deleted, or split. Existing personal memory and past chat messages remain intact. Other entities begin fresh memory stores. This is a logical memory boundary, not filesystem/process isolation: shared workspace files and any facts already present in chat history remain accessible. No automatic sharing or selective import of personal memories is implemented.

## Native colleague management tools

Chat and background automation runs expose `ReadColleagueSettings`, `UpdateColleagueSettings`, `ListAutomations`, `ReadAutomation`, `CreateAutomation`, `UpdateAutomation`, `RunAutomation`, `ReadAutomationRuns`, and `DeleteAutomation` as native Cortex tools. They remain visible without tool discovery or browser callbacks. Settings include identity, portrait, availability, model, reasoning effort, and memory learning, subject to the same owner restrictions as the UI. Changes apply to subsequent turns and runs.

Concierge issues a random, 30-minute capability for each run, stored by token hash in its existing Redis database and bound to the authenticated user and resolved executing entity. Cortex forwards it only to the configured `CONCIERGE_AGENT_TOOLS_URL`, with redirects disabled. The gateway revalidates current user/entity access and reuses existing settings and automation handlers within an AsyncLocalStorage user scope. Only explicit tool parameters are forwarded; inherited model and reasoning arguments cannot become accidental settings updates. Repeated tool call IDs return cached responses, with a short Redis lock for concurrent duplicates. This prevents ordinary request replays; it is not a transaction across MongoDB, CFH and Redis, so a process failure after a side effect but before caching can still require reconciliation.

Task creation binds the executing entity server-side. Read, update, run, history, and delete require an owned task assigned to that entity; the personal assistant also sees legacy unassigned tasks. A model cannot change the owner or assignment through this gateway. Existing browser sharing and editor flows retain their permissions.

Configure Cortex `CONCIERGE_AGENT_TOOLS_URL` to the absolute Concierge `/api/agent-tools` endpoint. Concierge web and workers must share their Redis capability store. The callback must be reachable from Cortex through any platform authentication layer; the route bypasses the ordinary browser sign-in proxy and authenticates its own scoped bearer capability. It needs no new shared secret. When the endpoint or capability is absent, Cortex omits these native tools. Deploy the gateway and capability-issuing web/worker code together with Cortex configuration before verifying background management tools.

## First-run results and portraits

A task with no run history shows a waiting page, its next scheduled time or watched folder when enabled, and Run now and Edit actions for writers. The latest view polls for its first run. Queued or failed runs without HTML show the existing status view; an HTML viewer opens only when output exists. Run-history failures show Retry rather than an empty-state message. `?edit=1` opens the editor even for HTML-producing tasks.

Wisp portraits use shaded SVGs in six colors, with staggered idle floats, stretches, sways, glances, and blinks. Hover and keyboard focus greet the user; eyes follow the pointer, and taps cycle through a hop, wiggle, and nod. Motion tracks use separate SVG groups with matching home frames at both ends. Reactions finish before the next begins, with at most one pending response; idle motion continues underneath without being replaced. Offscreen and hidden-document animations stop, and listeners/timers are cleaned up on unmount. Existing portrait identifiers retain their saved values and now select colors. Reduced-motion preferences disable animation. The sidebar uses a gray Wisp outline with the same typography and alignment as the other navigation items.

The personal assistant uses the reserved `personal` portrait, rendered as polished gold in the directory, chat selector, larger chat header, and docked chat. Cortex reports that portrait in settings and validates the reservation; other colleagues retain their six colors. Visible, motion-enabled Wisps share one passive page pointer listener and one requestAnimationFrame queue. Geometry reads precede transform writes, with no React updates, and gaze settles after 1.1 seconds without pointer movement. Reduced motion, hidden pages, and offscreen portraits unsubscribe from tracking.


## Assistant handoffs and resumable questions

See [Assistant handoffs](assistant-handoffs.md) for assistant messaging, parallel and sequential work, and notification chats that resume waiting tasks.

## Shared definitions and attached materials

`assistantVisibility` is private (default) or public; `assistantAccess` contains context IDs with viewer or editor roles. `colleagueOwnerId` and the single author association remain unchanged. The directory includes accessible definitions. Only owners change sharing or lifecycle; coauthors can change identity, defaults, and attached files. Viewers can execute and maintain their own preferences.

Execution user context propagates through AsyncLocalStorage from the signed storage grant or the trusted Concierge request file plan. Nested tools cannot replace it. Shared definitions resolve workspace operations to that user's validated personal entity and a stable assistant subdirectory. User-created assistants inherit the executing user's custom connections. Private memory continues to use the user/entity namespace. Workspace reset, stop and destruction remain personal-assistant operations.

The material context is derived server-side from the entity ID as `applet-shared:<hash>`. Concierge authorizes this namespace against accessible assistant metadata and issues read/list scopes to runs; upload/delete require authorship. `assistantMaterials` enables automatic loading of root AGENTS.md, skills/*/SKILL.md and a reference-file index through the existing agentContext loader. These files augment any applet context. Definitions carry no private user workspace files or credentials.

The tool-free `sys_assistant_draft` pathway generates editable name, description and instructions from a role description. It neither saves a definition nor grants authority. Recruitment requires an existing accessible ID; it never creates permanent identities.

Changes are read on subsequent invocations, not pinned across an entire project. Revocation and archive prevent later starts and material authorization; they do not retract already loaded instructions, issued short-lived grants, completed work or copied files. Existing runs may finish. Test shared assistant execution with two users before a paired deployment.
