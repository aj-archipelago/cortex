#!/bin/bash

# Check if FFmpeg is already installed
if ! command -v ffmpeg &> /dev/null; then
    echo "FFmpeg not found. Installing..."

    apt-get update

    apt-get install -y ffmpeg

    echo "FFmpeg installed successfully."
else
    echo "FFmpeg is already installed."
fi

# Start your application
echo "Starting your application..."
node start.js