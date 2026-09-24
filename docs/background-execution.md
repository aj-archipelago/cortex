# Bounded background execution

Concierge digest and automation jobs may send `x-cortex-deadline` with an absolute Unix timestamp in milliseconds. Cortex validates it, retains it across asynchronous registration, and cancels the request when it expires. Ordinary calls without the header keep their existing timeout behavior and perform no additional Redis read at async startup.

Cancellation is applied locally and broadcast on `requestCancellation`. A one-hour Redis marker also covers cancellation before the owner starts a bounded request. An instance receiving cancellation for an unknown ID must not create a local request placeholder: that would prevent subscription forwarding to the owner. Streaming and non-streaming model calls register abort hooks on both their child and parent IDs. Subsequent nested model dispatch checks parent cancellation.

This is cooperative cancellation, not a transaction over external tools. HTTP abort cannot prove an external service stopped processing, and completed file writes or connector actions cannot be undone. Concierge therefore does not automatically replay an agent whose execution already started, and holds its background capacity reservation through the deadline when the outcome is uncertain.

Deploy the updated Cortex cancellation protocol before enabling the paired Concierge background runner. Drain old digest batches during upgrades. Local tests cover deadlines, parent/child abort, no provider retry after cancellation, and cancellation between two processes sharing disposable Redis. Validate mixed interactive/background workloads, provider throttling and worker replacement in a staging environment before rollout.
