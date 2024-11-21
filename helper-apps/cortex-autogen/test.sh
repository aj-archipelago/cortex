#!/bin/bash

# Load environment variables
if [ -f .env ]; then
    export $(cat .env | xargs)
else
    echo ".env file not found"
    exit 1
fi

# Check if required variables are set
if [ -z "$AZURE_STORAGE_CONNECTION_STRING" ] || [ -z "$QUEUE_NAME" ]; then
    echo "AZURE_STORAGE_CONNECTION_STRING and QUEUE_NAME must be set in .env file"
    exit 1
fi

# Prompt for message if not provided as argument
if [ -z "$1" ]; then
    read -p "Enter message: " MESSAGE
else
    MESSAGE="$1"
fi

# Create JSON with message field
JSON_MESSAGE=$(jq -n --arg msg "$MESSAGE" '{"message": $msg}')

# Encode JSON message to Base64
ENCODED_MESSAGE=$(echo -n "$JSON_MESSAGE" | base64)

# Send message to queue
az storage message put \
    --connection-string "$AZURE_STORAGE_CONNECTION_STRING" \
    --queue-name "$QUEUE_NAME" \
    --content "$ENCODED_MESSAGE"

if [ $? -eq 0 ]; then
    echo "Message sent successfully."
else
    echo "Error sending message."
fi