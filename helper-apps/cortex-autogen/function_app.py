import azure.functions as func
import logging
import json
from azure.storage.queue import QueueClient
import os
import redis
from agents import process_message
import subprocess
import sys
import config
import requests

logging.getLogger().setLevel(logging.WARNING)

import subprocess, sys, importlib
required_packages = ['requests', 'azure-storage-blob']  # Add any and all other required packages
for package in required_packages:
    try:
        importlib.import_module(package)
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", package, "--disable-pip-version-check"], stderr=subprocess.STDOUT, stdout=subprocess.DEVNULL)


app = func.FunctionApp()

connection_string = os.environ["AZURE_STORAGE_CONNECTION_STRING"]
queue_name = os.environ.get("QUEUE_NAME", "autogen-message-queue")
queue_client = QueueClient.from_connection_string(connection_string, queue_name)

redis_client = redis.from_url(os.environ['REDIS_CONNECTION_STRING'])
channel = 'requestProgress'


@app.queue_trigger(arg_name="msg", queue_name=queue_name, connection="AZURE_STORAGE_CONNECTION_STRING")
def queue_trigger(msg: func.QueueMessage):
    logging.info(f"Queue trigger Message ID: {msg.id}")
    try:
        message_data = json.loads(msg.get_body().decode('utf-8'))
        if "requestId" not in message_data:
            message_data['requestId'] = msg.id
        process_message(message_data, msg)
        
    except Exception as e:
        logging.error(f"Error processing message: {str(e)}")
