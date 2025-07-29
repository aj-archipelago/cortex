from pathlib import Path
import asyncio
from autogen_ext.models.openai import OpenAIChatCompletionClient
from autogen_agentchat.teams import SelectorGroupChat
import os   
from autogen_agentchat.messages import UserMessage
from autogen_ext.models.openai import OpenAIChatCompletionClient
from autogen_agentchat.conditions import TextMentionTermination
from autogen_agentchat.conditions import HandoffTermination
from autogen_ext.models.openai import OpenAIChatCompletionClient
from services.azure_queue import get_queue_service
from services.redis_publisher import get_redis_publisher
import os
import json
import base64
import asyncio
from services.azure_queue import get_queue_service
from services.redis_publisher import get_redis_publisher
from agents import get_agents

import sys
import os

# Add the parent directory of 'src' to sys.path to allow imports like 'from cortex_autogen2.tools import ...'
# This is crucial when running main.py directly from outside the 'src' directory.
current_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.abspath(os.path.join(current_dir, '..', '..'))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

#dotenv
from dotenv import load_dotenv
load_dotenv()

import logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logging.getLogger("azure.core.pipeline.policies.http_logging_policy").setLevel(logging.WARNING)
logger = logging.getLogger(__name__)


CORTEX_API_KEY = os.getenv("CORTEX_API_KEY")
CORTEX_API_BASE_URL = os.getenv("CORTEX_API_BASE_URL", "http://localhost:4000/v1")

o3_model_client = OpenAIChatCompletionClient(
    model="o3",
    api_key=CORTEX_API_KEY,
    base_url=CORTEX_API_BASE_URL,
    timeout=600
)

o4_mini_model_client = OpenAIChatCompletionClient(
    model="o4-mini",
    api_key=CORTEX_API_KEY,
    base_url=CORTEX_API_BASE_URL,
    timeout=600
)

gpt41_model_client = OpenAIChatCompletionClient(
    model="gpt-4.1",
    api_key=CORTEX_API_KEY,
    base_url=CORTEX_API_BASE_URL,
    timeout=600
)


async def summarize_progress(content: str, model_client) -> str:
    try:
        # Ensure content is a string for the prompt
        if not isinstance(content, str):
            if isinstance(content, dict):
                content = json.dumps(content)  # Serialize the dictionary to a JSON string
            else:
                content = str(content)  # Fallback to general string conversion
        
        # Enhanced prompt for more descriptive summaries
        # lets also make it put a emoji in the beginning, use best emojis
        prompt = f"""Generate a concise, fun, and professional update (5-15 words or a short phrase) that clearly indicates the current progress or state of the task together with a emoji:\n\nTask Progress Details: {content}\n\nMake it engaging and highly informative without being overly technical. Examples: '🔍 Analyzing Data Trends', '🔧 Building New Features', '⤴️ Refining SQL Queries', '📓 Compiling Reports', '🚀 Deploying Updates'."""
        
        # Explicitly ensure content is a string for UserMessage constructor and provide a source
        messages = [UserMessage(content=str(prompt), source="summarize_progress_function")]  # Add source parameter
        
        # Debugging: Log the type and content of messages before sending to the model
        logging.debug(f"Messages type: {type(messages)}, Content: {messages}")

        response = await model_client.create(
            messages=messages  # Pass the fully validated messages list
        )
        return response.content.strip() # Correctly access content directly from CreateResult
    except Exception as e:
        logging.error(f"Error in summarize_progress: {e}")
        return "Error summarizing progress: Invalid message format encountered."  # Fallback response


async def handle_progress_update(task_id: str, percentage: float, content: str, model_client, progress_tracker):
    summarized_content = await summarize_progress(content, model_client)
    await progress_tracker.publish_progress(task_id, percentage, summarized_content)


async def process_task(task_id: str, task_content: str, progress_tracker) -> None:
    task_completed_percentage = 0.05
    task = task_content
    

    termination = HandoffTermination(target="user") | TextMentionTermination("TERMINATE")

    agents, presenter_agent = await get_agents(gpt41_model_client, o3_model_client, gpt41_model_client)
    
    team = SelectorGroupChat(
        participants=agents,
        model_client=gpt41_model_client,
        termination_condition=termination,
        max_turns=10000
    )

    messages = []
    uploaded_file_urls = {}
    final_result_content = [] # Store only relevant content for final presentation
    detailed_task = f"""
    Accomplish and present your task to the user in a great way, Markdown, it ll be shown in a React app that supports markdown.
    Task: 
    {task}
    """
    # stream = society_of_mind_agent.run_stream(task=detailed_task)
    stream = team.run_stream(task=task)
    async for message in stream:
        messages.append(message)
        #some messages doesnt have this fields how to best handle it?
        source = message.source if hasattr(message, 'source') else None
        content = message.content if hasattr(message, 'content') else None 
        created_at = message.created_at if hasattr(message, 'created_at') else None
        logger.info(f"\n\n#SOURCE: {source}\n#CONTENT: {content}\n#CREATED_AT: {created_at}\n")
        #message fields: source, content, created_at, id, type
        task_completed_percentage += 0.01
        if task_completed_percentage >= 1.0:
            task_completed_percentage = 0.99
        if content:
            processed_content_for_progress = content
            if message.type == "ToolCallExecutionEvent" and hasattr(message, 'content') and isinstance(message.content, list):
                # Extract content from FunctionExecutionResult for progress updates
                error_contents = [res.content for res in message.content if hasattr(res, 'is_error') and res.is_error]
                if error_contents:
                    processed_content_for_progress = "\n".join(error_contents)
                else:
                    # If it's a tool execution event but not an error, still convert to string
                    processed_content_for_progress = str(message.content)

            # Check if the content is a JSON string from agent
            if isinstance(content, str):
                try:
                    json_content = json.loads(content)
                    if "download_url" in json_content and "blob_name" in json_content:
                        uploaded_file_urls[json_content["blob_name"]] = json_content["download_url"]
                        # Add file URLs to the content for the presenter
                        final_result_content.append(f"Uploaded file: [{json_content['blob_name']}]({json_content['download_url']})")
                except json.JSONDecodeError:
                    pass  # Not a JSON message, ignore
            
            #add all? content to the final result content
            final_result_content.append(str(content))

            asyncio.create_task(handle_progress_update(task_id, task_completed_percentage, processed_content_for_progress, gpt41_model_client, progress_tracker))




    #send a progress update with 95%
    await progress_tracker.publish_progress(task_id, 0.95, "🪄 Polishing the result...")


    result_limited_to_fit = "\n".join(final_result_content) # Combine only relevant content


    #run with presenter agent but feed it with messages
    presenter_task = f"""
    Present the task result in a great way, Markdown, it'll be shown in a React app that supports markdown that doesn't have access to your local files.
    Make sure to use all the info you have, do not miss any info.
    Make sure to have images, videos, etc. users love them.
    UI must be professional that is really important.

    TASK: 

    {task}

    RAW_AGENT_COMMUNICATIONS:

    {result_limited_to_fit}

    UPLOADED_FILES_SAS_URLS:

    {json.dumps(uploaded_file_urls, indent=2)}

    **CRITICAL INSTRUCTION: Analyze the RAW_AGENT_COMMUNICATIONS above. Your ONLY goal is to extract and present the final, user-facing result requested in the TASK. Absolutely DO NOT include any code, internal agent thought processes, tool calls, technical logs, or descriptions of how the task was accomplished. Focus solely on delivering the ANSWER to the user's original request in a clear, professional, and visually appealing Markdown format. If the task was to fetch news headlines, present only the headlines. If it was to generate an image, present the image. If it was to create a file, indicate its content or provide its download URL. Remove all extraneous information.**
    """
    presenter_stream = presenter_agent.run_stream(task=presenter_task)
    presenter_messages = []
    async for message in presenter_stream:
        logger.info(f"#PRESENTER MESSAGE: {message.content if hasattr(message, 'content') else ''}")
        presenter_messages.append(message)

    task_result = presenter_messages[-1]
    last_message = task_result.messages[-1]
    text_result = last_message.content if hasattr(last_message, 'content') else None

    # Keep only the last message from the presenter as the final output, no extra filtering here.
    # The presenter itself is responsible for formatting it correctly based on its prompt.

    logger.info(f"🔍 TASK RESULT:\n{text_result}")
    # progress_tracker.store_final_result(task_id, text_result)
    await progress_tracker.publish_progress(task_id, 1.0, "🎉 Task complete.", data=text_result)



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
        progress_tracker = await get_redis_publisher()

        # Ensure all model clients are properly closed on shutdown
        clients_to_close = [
            o3_model_client,
            o4_mini_model_client,
            gpt41_model_client
        ]

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
                        
                        await process_task(task_id, task_content, progress_tracker)

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
            for client in clients_to_close:
                model_name = "unknown_model" # Default value
                try:
                    # Attempt to get model name safely
                    if hasattr(client, 'model'):
                        model_name = client.model
                    elif hasattr(client, '__class__'):
                        model_name = client.__class__.__name__ # Fallback to class name
                except Exception:
                    pass # Ignore errors during model name retrieval for logging
                
                try:
                    logger.info(f"🔌 Attempting to close client session for {model_name}.")
                    if client:
                        await client.close()
                    logger.info(f"🔌 Successfully closed client session for {model_name}.")
                except Exception as e:
                    logger.error(f"❌ Error closing client session for {model_name}: {e}")

            await progress_tracker.close()
            logger.info("🔌 Connections closed. Worker shutting down.")

    except Exception as e:
        logger.error(f"❌ Error in main loop: {e}")
        raise


if __name__ == "__main__":
    asyncio.run(main()) 




