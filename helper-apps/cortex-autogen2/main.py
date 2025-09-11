import asyncio
import os
import sys
import json
import base64
import logging
from services.azure_queue import get_queue_service
from task_processor import TaskProcessor

# Add the parent directory of 'src' to sys.path to allow imports like 'from cortex_autogen2.tools import ...'
# This is crucial when running main.py directly from outside the 'src' directory.
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.abspath(os.path.join(current_dir, '..', '..'))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

# Load environment variables
from dotenv import load_dotenv
load_dotenv()

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logging.getLogger("azure.core.pipeline.policies.http_logging_policy").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)


async def process_task(task_id: str, task_content: str, processor: TaskProcessor) -> None:
    """Process a single task using the TaskProcessor."""
    await processor.process_task(task_id, task_content)



async def main():
    """
    Main function to continuously process tasks from the Azure queue.
    """
    
    continuous_mode = os.getenv("CONTINUOUS_MODE", "true").lower() == "true"
    logger.info(f"🚀 Starting AutoGen Worker, continuous_mode: {continuous_mode}")

    # Add a small initial delay in non-continuous mode to allow tasks to be enqueued
    if not continuous_mode:
        await asyncio.sleep(1)

    try:
        azure_queue = await get_queue_service()
        processor = TaskProcessor()
        await processor.initialize()

        try:
            while True:  # Continuous loop
                try:
                    message = await azure_queue.get_task()
                    if message:
                        task_id = message.get("id")
                        pop_receipt = message.get("pop_receipt")
                        
                        if not task_id or not pop_receipt:
                            logger.error(f"❌ Invalid message format: {message}")
                            # Delete the invalid message to prevent infinite retry
                            if task_id and pop_receipt:
                                await azure_queue.delete_task(task_id, pop_receipt)
                            continue
                        
                        raw_content = message.get("content") or message.get("message")
                        if not raw_content:
                            logger.error(f"❌ Message has no content: {message}")
                            await azure_queue.delete_task(task_id, pop_receipt)
                            continue
                        
                        try:
                            decoded_content = base64.b64decode(raw_content).decode('utf-8')
                            task_data = json.loads(decoded_content)
                        except (json.JSONDecodeError, TypeError, ValueError) as e:
                            logger.warning(f"⚠️ Failed to decode as base64, trying as raw JSON: {e}")
                            try:
                                task_data = json.loads(raw_content)
                            except json.JSONDecodeError as e2:
                                logger.error(f"❌ Failed to parse message content: {e2}")
                                await azure_queue.delete_task(task_id, pop_receipt)
                                continue
                        
                        # Fix: Check message field first, then content field
                        task_content = task_data.get("message") or task_data.get("content")
                        if not task_content:
                            logger.error(f"❌ No task content found in: {task_data}")
                            await azure_queue.delete_task(task_id, pop_receipt)
                            continue
                        
                        logger.info(f"📩 Received task: {task_content}...")
                        
                        await process_task(task_id, task_content, processor)

                        await azure_queue.delete_task(task_id, pop_receipt)
                        logger.info(f"✅ Task {task_id} processed successfully.")
                    else:
                        if continuous_mode:
                            logger.info("⏳ No tasks in queue. Waiting 3 seconds...")
                            await asyncio.sleep(3)  # Wait before checking again
                        else:
                            logger.info("📭 No tasks in queue. Exiting (non-continuous mode).")
                            break
                            
                except Exception as e:
                    logger.error(f"❌ Error processing task: {e}")
                    if continuous_mode:
                        logger.info("📝 Continuing to next task...")
                        await asyncio.sleep(5)  # Brief pause before retrying
                    else:
                        raise  # Re-raise in non-continuous mode
                        
        finally:
            await processor.close()
            logger.info("🔌 Connections closed. Worker shutting down.")

    except Exception as e:
        logger.error(f"❌ Error in main loop: {e}")
        raise


if __name__ == "__main__":
    asyncio.run(main()) 




