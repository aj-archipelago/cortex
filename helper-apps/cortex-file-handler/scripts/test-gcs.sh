#!/bin/bash

# Exit on error
set -e

cleanup() {
    echo "Cleaning up..."
    if [ ! -z "$AZURITE_PID" ]; then
        kill $AZURITE_PID 2>/dev/null || true
    fi
    docker stop fake-gcs-server 2>/dev/null || true
    docker rm fake-gcs-server 2>/dev/null || true
}

# Set up cleanup trap
trap cleanup EXIT

echo "Starting test environment..."

# Start Azurite if not running
if ! nc -z localhost 10000; then
    echo "Starting Azurite..."
    azurite --silent --skipApiVersionCheck --location .azurite --debug .azurite/debug.log &
    AZURITE_PID=$!
    # Wait for Azurite to be ready
    until nc -z localhost 10000; do
        sleep 1
    done
fi

# Start fake-gcs-server if not running
if ! nc -z localhost 4443; then
    echo "Starting fake-gcs-server..."
    docker run -d --name fake-gcs-server \
        -p 4443:4443 \
        fsouza/fake-gcs-server -scheme http
    # Wait for fake-gcs-server to be ready
    until nc -z localhost 4443; do
        sleep 1
    done
fi

# Create containers
echo "Setting up test containers..."
node scripts/setup-test-containers.js

# Run the tests
echo "Running tests..."
node -r dotenv/config node_modules/ava/entrypoints/cli.mjs "$@" 