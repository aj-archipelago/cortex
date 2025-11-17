import azure.functions as func
import logging
import json
from azure.storage.queue import QueueClient
import os
import redis
from task_processor import process_queue_message
# from agents import process_message

# Configure logging
logging.getLogger().setLevel(logging.INFO)

# Reduce Autogen framework logging verbosity to avoid serialization issues
logging.getLogger('autogen_core').setLevel(logging.WARNING)
logging.getLogger('autogen_agentchat').setLevel(logging.WARNING)

# Suppress model mismatch warnings that are not actionable
logging.getLogger('autogen_ext.models.openai._openai_client').setLevel(logging.ERROR)

# Suppress verbose Azure SDK logging
logging.getLogger('azure.core.pipeline.policies.http_logging_policy').setLevel(logging.ERROR)
logging.getLogger('azure.storage.blob').setLevel(logging.ERROR)
logging.getLogger('azure.core').setLevel(logging.ERROR)
logging.getLogger('urllib3').setLevel(logging.WARNING)
logging.getLogger('urllib3.connectionpool').setLevel(logging.ERROR)
logging.getLogger('requests').setLevel(logging.WARNING)
# Suppress Azure Functions runtime logs completely
logging.getLogger('azure.functions').setLevel(logging.ERROR)
logging.getLogger('azure.monitor').setLevel(logging.ERROR)
# Suppress Azure Functions queue trigger verbose logs
logging.getLogger('azure.functions.queue').setLevel(logging.ERROR)
logging.getLogger('azure.functions.worker').setLevel(logging.ERROR)
# Suppress Azure Functions host logs
logging.getLogger('azure.functions.host').setLevel(logging.ERROR)
# Suppress HTTP request/response logging
logging.getLogger('httpx').setLevel(logging.WARNING)
logging.getLogger('httpcore').setLevel(logging.WARNING)

# Add more detailed logging for our components
logging.getLogger('task_processor').setLevel(logging.DEBUG)
logging.getLogger('agents').setLevel(logging.DEBUG)

app = func.FunctionApp()

connection_string = os.environ["AZURE_STORAGE_CONNECTION_STRING"]
queue_name = os.environ.get("AZURE_QUEUE_NAME") or os.environ.get("QUEUE_NAME", "autogen-message-queue")
logging.info(f"📦 Using Azure Storage Queue name: {queue_name}")
queue_client = QueueClient.from_connection_string(connection_string, queue_name)

redis_client = redis.from_url(os.environ['REDIS_CONNECTION_STRING'])
channel = 'requestProgress' or os.environ.get('REDIS_CHANNEL', 'requestProgress')
logging.info(f"📡 Using Redis channel: {channel}")


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
        
        # Process the message synchronously with per-request logger
        import asyncio
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        # Create a logger for this specific request
        request_logger = logging.getLogger(f"request.{msg.id}")
        request_logger.setLevel(logging.INFO)

        try:
            result = loop.run_until_complete(process_queue_message(message_data, logger=request_logger))
            if result:
                logging.info(f"✅ QUEUE_TRIGGER: Message {msg.id} processed successfully")
            else:
                logging.warning(f"⚠️ QUEUE_TRIGGER: Message {msg.id} returned no result")
        finally:
            loop.close()
            
    except Exception as e:
        logging.error(f"❌ QUEUE_TRIGGER: Error processing message {msg.id}: {e}", exc_info=True)
        raise
