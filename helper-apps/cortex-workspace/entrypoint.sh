#!/bin/bash
set -e

# Mount Azure Blob Storage at /cloud-files if credentials are provided, then
# expose it at /workspace/files as a compatibility symlink.
# The blob container name (e.g. cortexfiles-local, cortexfiles-local-abc123)
# comes from the AZURE_BLOB_CONTAINER env var, set per environment.
#
# Auth modes (checked in order):
#   1. SAS token  — AZURE_BLOB_SAS_TOKEN (preferred, container-scoped)
#   2. Account key — AZURE_STORAGE_ACCOUNT_KEY (legacy fallback)

WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
PERSIST_DIR="${WORKSPACE_PERSIST_DIR:-/persist}"
BLOB_FILES_DIR="${WORKSPACE_BLOB_FILES_DIR:-/cloud-files}"
CHECKPOINT_PATH="${WORKSPACE_CHECKPOINT_PATH:-$PERSIST_DIR/workspace.tar.gz}"

mkdir -p "$WORKSPACE_DIR" "$PERSIST_DIR" "$BLOB_FILES_DIR"

expose_blob_files() {
    local target="$WORKSPACE_DIR/files"

    umount "$target" >/dev/null 2>&1 || true
    umount -l "$target" >/dev/null 2>&1 || true
    if ! rm -rf "$target" >/dev/null 2>&1; then
        echo "WARNING: ${target} is busy; leaving existing cloud-files exposure in place"
        return 0
    fi

    if ln -s "$BLOB_FILES_DIR" "$target"; then
        echo "Exposed ${BLOB_FILES_DIR} at ${target} with symlink"
    else
        echo "WARNING: failed to symlink ${target} to ${BLOB_FILES_DIR}; leaving existing exposure in place"
    fi
}

if [ -f "$CHECKPOINT_PATH" ]; then
    echo "Restoring workspace checkpoint from ${CHECKPOINT_PATH}"
    tar xzf "$CHECKPOINT_PATH" -C "$WORKSPACE_DIR"
elif find "$PERSIST_DIR" -mindepth 1 \
    ! -name 'workspace.tar.gz' \
    ! -name 'workspace.tar.gz.tmp' \
    ! -name 'workspace.tar.gz.*.tmp' \
    ! -name 'workspace.prev.tar.gz' \
    -print -quit | grep -q .; then
    echo "Importing legacy workspace files from ${PERSIST_DIR}"
    tar \
        --exclude='./workspace.tar.gz' \
        --exclude='./workspace.tar.gz.tmp' \
        --exclude='./workspace.tar.gz.*.tmp' \
        --exclude='./workspace.prev.tar.gz' \
        -cf - -C "$PERSIST_DIR" . | tar xf - -C "$WORKSPACE_DIR"
fi

if [ -n "$AZURE_STORAGE_ACCOUNT_NAME" ] && [ -n "$AZURE_BLOB_CONTAINER" ]; then
    # Determine auth mode
    AUTH_MODE=""
    if [ -n "$AZURE_BLOB_SAS_TOKEN" ]; then
        AUTH_MODE="sas"
    elif [ -n "$AZURE_STORAGE_ACCOUNT_KEY" ]; then
        AUTH_MODE="key"
    fi

    if [ -n "$AUTH_MODE" ]; then
        MOUNT_DIR="$BLOB_FILES_DIR"
        CACHE_DIR="/tmp/blobfuse2"

        mkdir -p "$MOUNT_DIR" "$CACHE_DIR"

        echo "Mounting blob storage ($AUTH_MODE): ${AZURE_BLOB_CONTAINER} -> ${MOUNT_DIR}"

        # Generate blobfuse2 config — auth section varies by mode
        cat > /tmp/blobfuse2-config.yaml <<BFEOF
logging:
  type: syslog
  level: log_warning

components:
  - libfuse
  - file_cache
  - attr_cache
  - azstorage

libfuse:
  attribute-expiration-sec: 120
  entry-expiration-sec: 120
  negative-entry-expiration-sec: 240

file_cache:
  path: ${CACHE_DIR}
  timeout-sec: 120

attr_cache:
  timeout-sec: 7200

azstorage:
  type: block
  account-name: ${AZURE_STORAGE_ACCOUNT_NAME}
  endpoint: https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net
  container: ${AZURE_BLOB_CONTAINER}
BFEOF

        # Append auth credentials based on mode
        if [ "$AUTH_MODE" = "sas" ]; then
            cat >> /tmp/blobfuse2-config.yaml <<BFEOF
  mode: sas
  sas: ${AZURE_BLOB_SAS_TOKEN}
BFEOF
        else
            cat >> /tmp/blobfuse2-config.yaml <<BFEOF
  account-key: ${AZURE_STORAGE_ACCOUNT_KEY}
BFEOF
        fi

        blobfuse2 mount "$MOUNT_DIR" --config-file=/tmp/blobfuse2-config.yaml \
            --allow-other \
            --set-content-type=true \
            -o nonempty \
            2>&1 || echo "WARNING: blobfuse2 mount failed (container may lack SYS_ADMIN capability)"
    else
        echo "No blob storage credentials — ${BLOB_FILES_DIR}/ is a regular directory"
    fi
else
    echo "No blob storage credentials — ${BLOB_FILES_DIR}/ is a regular directory"
fi

expose_blob_files

# Run the CMD (default: node server.js)
exec "$@"
