import azure.functions as func
import logging
import json
import autogen
from autogen import AssistantAgent, UserProxyAgent, config_list_from_json
from azure.storage.queue import QueueClient
import os
import tempfile
import redis
from myautogen import process_message

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
