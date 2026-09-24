# Workspace checkpoint safety

Workspace checkpoints preserve a last-known-good archive and record the exact runtime and entity that produced each candidate. Provisioning and restore operations use renewable ownership leases. A stale attempt cannot publish metadata over a newer runtime.

The workspace helper inventories files before and after creating an encrypted archive. Concurrent writes invalidate the candidate. An empty archive or a material reduction from the previous inventory does not silently replace a useful checkpoint. The owner can review an exact candidate; changing its contents invalidates that approval. Reset and destruction preserve recovery material first.

Use the updated workspace helper together with the updated Cortex lifecycle code. Build the helper from `helper-apps/cortex-workspace`, set the workspace image configuration for your installation, and verify a fresh workspace, an existing workspace, and a restore before changing idle-reaper policy. Pause lifecycle operations during a coordinated upgrade if old and new workers would otherwise update the same metadata.

Validate a real file round trip, a concurrent edit during checkpointing, an interrupted upload, lease loss, and a reduction that requires review. A successful archive upload alone does not prove that the restored files are correct. Compare restored file contents with the candidate inventory.

Retain the last verified checkpoint and your storage provider's previous object version until a restore has been checked. Roll back application and helper versions together; preserve checkpoint metadata and recovery objects. Do not fall back to an older legacy share after a verified Blob checkpoint fails to restore, because that can discard newer work.
