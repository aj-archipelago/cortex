import os
from azure.storage.queue import QueueClient
import base64
import json
from myautogen import process_message
import time

def main():
    print("Starting message processing loop")
    connection_string = os.environ["AZURE_STORAGE_CONNECTION_STRING"]
    queue_name = os.environ.get("QUEUE_NAME", "autogen-message-queue")

    queue_client = QueueClient.from_connection_string(connection_string, queue_name)
    
    attempts = 0
    max_attempts = 100
    

    while attempts < max_attempts:
        messages = queue_client.receive_messages(messages_per_page=1)
        
        if messages:
            for message in messages:
                decoded_content = base64.b64decode(message.content).decode('utf-8')
                message_data = json.loads(decoded_content)
                if "requestId" not in message_data:
                    message_data['requestId'] = message.id
                process_message(message_data, message)
                queue_client.delete_message(message)
            attempts = 0  # Reset attempts if a message was processed
        else:
            attempts += 1
            time.sleep(1)  # Wait for 1 second before checking again

    print("No messages received after 100 attempts. Exiting.")

if __name__ == "__main__":
    main()