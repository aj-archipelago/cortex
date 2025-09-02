#!/bin/bash

# Create temp directory for Azurite
AZURITE_DIR="/tmp/azurite-test"
mkdir -p $AZURITE_DIR

# Start Azurite in background
echo "Starting Azurite..."
azurite --silent --skipApiVersionCheck --location $AZURITE_DIR &
AZURITE_PID=$!

# Wait for Azurite to start
sleep 2

# Create test container
echo "Setting up Azure container..."
node scripts/setup-azure-container.js

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