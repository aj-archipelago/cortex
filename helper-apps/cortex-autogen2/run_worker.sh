#!/bin/bash
# Helper script to run the cortex-autogen2 worker

cd "$(dirname "$0")"
source .venv/bin/activate

# Kill any previously running workers
pkill -f "python main.py" || true
pkill -f "python -m src.cortex_autogen2.main" || true

# Set default to non-continuous mode if not specified
CONTINUOUS_MODE=${CONTINUOUS_MODE:-false}

echo "🚀 Starting AutoGen Worker (CONTINUOUS_MODE=$CONTINUOUS_MODE)"
echo "📝 Send tasks using: python send_task.py \"your task here\""
echo ""

CONTINUOUS_MODE=$CONTINUOUS_MODE python main.py

