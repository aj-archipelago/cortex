#!/usr/bin/env python3
"""
🚀 Cortex AutoGen Task Sender

This script sends tasks to the Azure Queue for processing by the Cortex AutoGen worker.

⚠️  CRITICAL: WORKER MANAGEMENT REQUIRED BEFORE TESTING
================================================================================
ALWAYS kill existing workers before starting new ones to prevent conflicts:

1. KILL EXISTING WORKERS:
   pkill -f "python -m src.cortex_autogen2.main"
   
2. VERIFY NO WORKERS RUNNING:
   ps aux | grep cortex_autogen2
   (Should only show the grep command itself)
   
3. START FRESH WORKER:
   CONTINUOUS_MODE=false python -m src.cortex_autogen2.main &
   
4. SEND TASK:
   python send_task.py "Your task here" --wait --timeout 120

⚠️  Multiple workers can cause:
- Task processing conflicts
- Duplicate progress updates  
- Queue message conflicts
- Unpredictable behavior

ALWAYS ensure clean worker state before testing!
================================================================================

📋 TWO-STEP WORKFLOW:
1. SEND TASK: Use this script to send a task to the queue
2. START WORKER: Run the worker to process the task

⚠️  IMPORTANT: You MUST send a task FIRST, then start the worker!

🔧 WORKER COMMANDS:
- Continuous mode: python -m src.cortex_autogen2.main
- Non-continuous mode: CONTINUOUS_MODE=false python -m src.cortex_autogen2.main

📝 USAGE EXAMPLES:

# RECOMMENDED WORKFLOW:
# Step 0: Kill existing workers
pkill -f "python -m src.cortex_autogen2.main"

# Step 1: Start fresh worker
CONTINUOUS_MODE=false python -m src.cortex_autogen2.main &

# Step 2: Send task and wait
python send_task.py "create a simple PDF about cats" --wait --timeout 120

# Alternative: Send task first, then start worker manually
python send_task.py "calculate 5 + 3"
CONTINUOUS_MODE=false python -m src.cortex_autogen2.main

💡 PRO TIPS:
- Use --continuous=false for testing single tasks
- Use --wait to automatically listen for the response
- Tasks persist in the queue until processed
- ALWAYS kill existing workers before starting new tests

🔍 TECHNICAL DETAILS:
- Task content uses "contextId", "message", and "keywords" (matches UI format)
- Progress updates use Azure Queue's "messageId" as the "requestId" field
- Base64 encodes the JSON payload (like the UI)
- Redis channel: requestProgress

📋 ID MAPPING:
- contextId: Original task context ID (for reference)
- messageId: Azure Queue message ID (used for progress updates as requestId)
- requestId: Same as messageId (used in Redis progress messages)
"""

import json
import uuid
import argparse
import base64
from azure.storage.queue import QueueClient
from dotenv import load_dotenv
import os

def main():
    """Sends a simple task to the Azure Queue."""
    load_dotenv()
    
    parser = argparse.ArgumentParser(description="Send a task to the AutoGen agent processor.")
    parser.add_argument("task_prompt", type=str, nargs='?', default="list the files in the current directory",
                        help="The prompt for the task to be executed.")
    args = parser.parse_args()

    connection_string = os.getenv("AZURE_STORAGE_CONNECTION_STRING")
    queue_name = os.getenv("AZURE_QUEUE_NAME", "autogen-test-message-queue")
    print(f"Using queue: {queue_name}")
    
    if not connection_string:
        print("Error: AZURE_STORAGE_CONNECTION_STRING is not set.")
        return
        
    task = {
        "request_id": str(uuid.uuid4()),
        "message_id": str(uuid.uuid4()),
        "content": args.task_prompt
    }
    
    message = json.dumps(task)
    
    # Encode message as Base64 to match Azure Functions MessageEncoding setting
    encoded_message = base64.b64encode(message.encode('utf-8')).decode('utf-8')
    
    # Use synchronous client for instant execution
    queue_client = QueueClient.from_connection_string(connection_string, queue_name)
    queue_client.send_message(encoded_message)
    print(f"Task sent to queue '{queue_name}': {task}")
    print(f"Message encoded as Base64: {encoded_message[:50]}...")

if __name__ == "__main__":
    main() 