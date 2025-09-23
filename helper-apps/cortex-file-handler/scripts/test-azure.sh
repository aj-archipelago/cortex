#!/bin/bash

# Validate environment variables first - fail fast if missing
echo "🔍 Validating environment configuration..."
DOTENV_CONFIG_PATH=.env.test.azure NODE_ENV=test node -r dotenv/config scripts/validate-env.js
if [ $? -ne 0 ]; then
    echo "❌ Environment validation failed. Exiting."
    exit 1
fi

# Create temp directory for Azurite
AZURITE_DIR="/tmp/azurite-test"
mkdir -p $AZURITE_DIR

# Start Azurite in background
echo "🚀 Starting Azurite..."
azurite --silent --skipApiVersionCheck --location $AZURITE_DIR &
AZURITE_PID=$!

# Wait for Azurite to start and verify it's running
echo "⏳ Waiting for Azurite to start..."
sleep 3

# Verify Azurite is responding
echo "🔗 Checking Azurite connectivity..."
timeout 10s bash -c 'until curl -s http://127.0.0.1:10000/devstoreaccount1?comp=list >/dev/null 2>&1; do sleep 1; done' || {
    echo "❌ Azurite failed to start or is not responding"
    kill $AZURITE_PID 2>/dev/null
    exit 1
}

# Create test container
echo "📦 Setting up Azure containers..."
DOTENV_CONFIG_PATH=.env.test.azure NODE_ENV=test node -r dotenv/config scripts/setup-azure-container.js
if [ $? -ne 0 ]; then
    echo "❌ Container setup failed. Exiting."
    kill $AZURITE_PID 2>/dev/null
    exit 1
fi

# Run the tests
echo "Running tests..."
echo "🔍 Starting AVA test runner..."
echo "📋 Test files to run:"
find tests -name "*.test.js" | head -10
echo "⚡ Executing AVA..."
timeout 300s node -r dotenv/config node_modules/ava/entrypoints/cli.mjs "$@" --verbose

# Store test result
TEST_RESULT=$?

# Kill Azurite
echo "Cleaning up..."
kill $AZURITE_PID

# Wait for Azurite to finish cleanup
sleep 2

# Clean up Azurite directory
rm -rf $AZURITE_DIR

# Exit with test result
exit $TEST_RESULT 