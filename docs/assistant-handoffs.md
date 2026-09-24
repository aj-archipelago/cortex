# Assistant handoffs and questions

Assistants send durable request/reply messages through the existing agent-tool gateway. `ListAssistants` discovers accessible identities. `MessageAssistants` starts one ordinary background agent task per message; a batch runs in parallel. The sender receives the replies in its next turn and can request the next stage. No workflow definition, stage graph, separate orchestrator, or suspended model process is stored.

`AskUser` uses the same envelope with a private question chat as its destination. The notification opens that exact chat, with the assistant that asked. The stream route adds the original task, checkpoint, and file locations from server-owned records. `AnswerTaskQuestion` records the assistant's summary of the user's answer. It requires the owning user, the original assistant, an unshared question chat, and a persisted user reply. A greeting or another question should not be resolved; prompts require enough information and explicit approval when the task calls for it. Closing the chat is not an answer. This is a conversational decision, not a new approval policy engine.

## State and execution

- `AssistantMessage`: source task/turn, sender, recipient or question chat, delivery state, encrypted request/checkpoint/answer. It is also the durable outbox. Delivery retries reuse deterministic message, child-task, notification and chat IDs.
- Existing `Task`: bound assistant, root ID, turn number, pending-replies flag, and encrypted original brief/latest progress. Child tasks use `assistant-run`; automation continuations retain the same task/run ID and output paths.
- Existing `Chat`: an optional question ID. Question chats are excluded from ordinary notification chat reuse.
- Existing Redis capabilities additionally bind the source task/turn or private chat. Model parameters cannot choose the owner, source task, root, or answer destination.

`wait=true` ends the Cortex turn after its current tool batch. `wait=false` permits independent work; at the end of the turn, a task with outgoing requests waits for all replies from that turn. The existing minute scheduler delivers outbox records, collects completed child results, and resumes ready tasks. It waits for the preceding worker heartbeat to disappear. A compare-and-set advances the turn; a deterministic BullMQ receipt makes enqueue repair idempotent. Waiting consumes no worker slot and has no human-answer timeout. It is excluded from abandoned-task cleanup and blocks overlapping scheduled runs of the same automation.

Continuation prompts contain the original instructions and data locations, the preceding turn's output, handoff checkpoints and new replies. Chat-originated work also reads the recent private source chat to preserve work completed after dispatch. They require reading the referenced files and avoiding repeated side effects. Failed child work is returned as a failure, never as approval. The final automation report is saved only after outstanding handoffs are resolved. Task pages show **Waiting for replies** and keep polling.

Parallel assistants share the user's workspace, not a document lock. Requests should give editors separate version paths; the coordinating assistant combines them after the replies. Existing files, tools, memory boundaries, notifications, and normal chat are reused. There is no cross-user messaging. Accessible shared specialists can participate under the current user's context.

## Bounds and operations

One batch accepts up to eight messages. A root task permits 64 durable messages, eight delegation levels and 32 turns per task to bound accidental cycles. Paused or archived identities cannot start another background turn. Cancelled roots do not start further child work or continuations. Existing running external operations are not rolled back. Exactly-once external tool side effects are not promised; task instructions must remain safe to retry after failure.

Deploy Cortex, Concierge web and assignment-aware workers together before enabling this flow. The existing `CONCIERGE_AGENT_TOOLS_URL` and shared Redis capability store are used. Mongo schema encryption adds `tasks.assistantContext` and `assistantmessages.payload`; routing fields stay queryable. Provision the declared `assistantmessages` indexes and the Task waiting index through the normal index rollout. No old records or reports are migrated. Local implementation does not deploy these changes.


Private chats now receive current task receipts. `ReadAssistantTasks` reads live status without sending work. `MessageAssistants` returns named receipts and refuses another outstanding request to the same recipient in a chat unless it is an explicitly separate assignment. Recipients receive their other active and recent assignments before starting and should return a clarification to the sender if the work appears duplicated. Notifications name the assistant and group recipient requests under their parent task. Results return to the source private chat when available. No additional workflow state is introduced.


Team workflows add a shared root assignment and explicit reviewed completion on top of these handoffs. See Concierge `docs/assistant-teams.md` for recruitment, peer questions, reviews, and execution bounds.
