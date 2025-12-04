import asyncio
from azure.storage.queue.aio import QueueServiceClient, QueueClient
from azure.core.exceptions import ResourceExistsError, AzureError
import os
import logging

logger = logging.getLogger(__name__)

class AzureQueueService:
    """
    A service for interacting with Azure Queue Storage.
    """

    def __init__(self, connection_string: str, queue_name: str):
        self.connection_string = connection_string
        self.queue_name = queue_name
        self.queue_client = QueueClient.from_connection_string(
            conn_str=self.connection_string, queue_name=self.queue_name
        )

    async def initialize(self):
        """
        Initializes the queue, creating it if it doesn't exist.
        """
        try:
            await self.queue_client.create_queue()
        except ResourceExistsError:
            pass
        except Exception as e:
            logger.error(f"💥 Failed to create or connect to queue '{self.queue_name}': {e}")
            raise

    async def get_task(self) -> dict | None:
        """
        Receives a single message from the queue.
        """
        try:
            messages = self.queue_client.receive_messages(
                messages_per_page=1,
                visibility_timeout=1800,
                timeout=30
            )

            async for message in messages:
                logger.info(f"📨 Azure Queue: Received message with ID: {message.id}")
                logger.debug(f"📨 Raw message content: {message.content}")
                return {
                    "id": message.id,
                    "content": message.content,
                    "pop_receipt": message.pop_receipt,
                }
            return None

        except AzureError as e:
            logger.error(f"❌ Azure Queue: An Azure-specific error occurred: {e}")
            return None
        except Exception as e:
            logger.error(f"❌ Azure Queue: Unexpected error receiving message: {e}", exc_info=True)
            return None

    async def delete_task(self, message_id: str, pop_receipt: str):
        """
        Deletes a message from the queue after it has been processed.
        """
        try:
            await self.queue_client.delete_message(message_id, pop_receipt)
        except Exception as e:
            logger.error(f"💥 Failed to delete message {message_id}: {e}")
            raise

    async def peek_messages(self, max_messages: int = 1) -> list:
        """
        Peek at messages in the queue without consuming them.
        """
        try:
            messages = self.queue_client.peek_messages(max_messages=max_messages)
            result = []
            async for message in messages:
                result.append({
                    "id": message.id,
                    "content": message.content,
                })
            return result
        except Exception as e:
            logger.error(f"❌ Error peeking messages: {e}")
            return []

    async def close(self):
        """
        Closes the QueueClient.
        """
        await self.queue_client.close()

async def get_queue_service() -> AzureQueueService:
    """
    Factory function to create and initialize an AzureQueueService instance.
    """
    connection_string = os.getenv("AZURE_STORAGE_CONNECTION_STRING")
    queue_name = os.getenv("AZURE_QUEUE_NAME")

    if not connection_string:
        raise ValueError("AZURE_STORAGE_CONNECTION_STRING environment variable is required")
    if not queue_name:
        raise ValueError("AZURE_QUEUE_NAME environment variable is required")

    queue_service = AzureQueueService(connection_string, queue_name)
    await queue_service.initialize()
    return queue_service 