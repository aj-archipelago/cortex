import azure.functions as func
import logging
import json
from azure.storage.queue import QueueClient
import os
import redis
from task_processor import process_queue_message
# from agents import process_message

# logging.getLogger().setLevel(logging.WARNING)
logging.getLogger().setLevel(logging.INFO)

app = func.FunctionApp()

connection_string = os.environ["AZURE_STORAGE_CONNECTION_STRING"]
queue_name = os.environ.get("QUEUE_NAME", "autogen-message-queue")
queue_client = QueueClient.from_connection_string(connection_string, queue_name)

redis_client = redis.from_url(os.environ['REDIS_CONNECTION_STRING'])
channel = 'requestProgress'


@app.queue_trigger(arg_name="msg", queue_name=queue_name, connection="AZURE_STORAGE_CONNECTION_STRING")
def queue_trigger(msg: func.QueueMessage):
    """Queue trigger function to process Cortex AutoGen tasks."""
    logging.info(f"🔍 QUEUE_TRIGGER: Processing message {msg.id}")
    
    try:
        message_body = msg.get_body().decode('utf-8')
        message_data = {
            "id": msg.id,
            "content": message_body,
            "pop_receipt": None,
            "dequeue_count": msg.dequeue_count
        }
        
        logging.info(f"🔍 QUEUE_TRIGGER: Content: {message_data['content'][:100]}...")
        
        # Process the message synchronously
        import asyncio
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            result = loop.run_until_complete(process_queue_message(message_data))
            if result:
                logging.info(f"✅ QUEUE_TRIGGER: Message {msg.id} processed successfully")
            else:
                logging.warning(f"⚠️ QUEUE_TRIGGER: Message {msg.id} returned no result")
        finally:
            loop.close()
            
    except Exception as e:
        logging.error(f"❌ QUEUE_TRIGGER: Error processing message {msg.id}: {e}", exc_info=True)
        raise
