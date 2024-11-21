from azure.storage.queue import QueueClient
import pymongo
import os
import logging
import json
import base64
from config import AZURE_STORAGE_CONNECTION_STRING, HUMAN_INPUT_QUEUE_NAME

human_input_queue_client = QueueClient.from_connection_string(AZURE_STORAGE_CONNECTION_STRING, HUMAN_INPUT_QUEUE_NAME)

def store_in_mongo(data):
    try:
        if 'MONGO_URI' in os.environ:
            client = pymongo.MongoClient(os.environ['MONGO_URI'])
            collection = client.get_default_database()[os.environ.get('MONGO_COLLECTION_NAME', 'autogenruns')]
            collection.insert_one(data)
        else:
            logging.warning("MONGO_URI not found in environment variables")
    except Exception as e:
        logging.error(f"An error occurred while storing data in MongoDB: {str(e)}")

def check_for_human_input(request_id):
    messages = human_input_queue_client.receive_messages()
    for message in messages:
        content = json.loads(base64.b64decode(message.content).decode('utf-8'))
        if content['codeRequestId'] == request_id:
            human_input_queue_client.delete_message(message)
            return content['text']
    return None