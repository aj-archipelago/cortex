#!/bin/bash

# Create temp directory for Azurite
AZURITE_DIR="/tmp/azurite-test"
mkdir -p $AZURITE_DIR

# Start Azurite in background
echo "Starting Azurite..."
azurite --silent --location $AZURITE_DIR &
AZURITE_PID=$!

# Wait for Azurite to start
sleep 2

# Create test container
echo "Setting up Azure container..."
node scripts/setup-azure-container.js

# Run the tests
echo "Running tests..."
node -r dotenv/config node_modules/ava/entrypoints/cli.mjs

# Store test result
TEST_RESULT=$?

# Kill Azurite
echo "Cleaning up..."
kill $AZURITE_PID

# Clean up Azurite directory
rm -rf $AZURITE_DIR

# Exit with test result
exit $TEST_RESULT 