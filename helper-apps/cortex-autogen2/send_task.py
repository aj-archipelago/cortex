#!/usr/bin/env python3
"""
🚀 Cortex AutoGen Task Sender

Send a task to the Azure Storage Queue for processing by the Cortex AutoGen worker.

CRITICAL: Clean worker state prevents conflicts
----------------------------------------------
1) Kill existing workers:
   pkill -f "python -m src.cortex_autogen2.main" || true
   pkill -f "python main.py" || true

2) Start fresh worker (non-continuous) in background:
   CONTINUOUS_MODE=false python -m src.cortex_autogen2.main &
   # or: CONTINUOUS_MODE=false python main.py &

3) Send a task:
   python send_task.py "Create a simple PDF about cats and upload it"

Why this order? Multiple workers can cause duplicate processing, queue conflicts, and noisy progress updates.

Usage
-----
python send_task.py "<your task text>" [--queue <name>] [--connection <conn_str>]

Environment
-----------
- AZURE_STORAGE_CONNECTION_STRING (required if --connection not provided)
- AZURE_QUEUE_NAME (default queue if --queue not provided)
- .env is loaded automatically

Message format
--------------
- Base64-encoded JSON payload with a `content` field:
  {"request_id": "<uuid>", "message_id": "<uuid>", "content": "<task text>"}

Notes
-----
- Tasks persist in the queue until a worker processes them.
- Progress is published to Redis (see README for details).
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
    parser.add_argument(
        "task_prompt",
        type=str,
        nargs='?',
        default="list the files in the current directory",
        help="The prompt for the task to be executed."
    )
    parser.add_argument(
        "--queue",
        dest="queue_name",
        type=str,
        default=os.getenv("AZURE_QUEUE_NAME", "autogen-test-message-queue"),
        help="Azure Storage Queue name (overrides AZURE_QUEUE_NAME)."
    )
    parser.add_argument(
        "--connection",
        dest="connection_string",
        type=str,
        default=os.getenv("AZURE_STORAGE_CONNECTION_STRING"),
        help="Azure Storage connection string (overrides AZURE_STORAGE_CONNECTION_STRING)."
    )
    args = parser.parse_args()

    connection_string = args.connection_string
    queue_name = args.queue_name
    print(f"Using queue: {queue_name}")
    
    if not connection_string:
        print("Error: AZURE_STORAGE_CONNECTION_STRING is not set and --connection was not provided.")
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
    queue_client.send_message(encoded_message, visibility_timeout=0)
    print(f"Task sent to queue '{queue_name}': {task}")
    print(f"Message encoded as Base64: {encoded_message[:50]}...")

if __name__ == "__main__":
    main() 