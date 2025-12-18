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

python3 -c "
import os
import sys
from dotenv import load_dotenv

# Load .env file
load_dotenv()

# Set CONTINUOUS_MODE from environment or default
if 'CONTINUOUS_MODE' not in os.environ:
    os.environ['CONTINUOUS_MODE'] = '$CONTINUOUS_MODE'

# Now run main.py
os.execvp('python', ['python', 'main.py'] + sys.argv[1:])
"

