import asyncio
import json
import base64
import logging
from typing import Optional, Dict, Any
from autogen_ext.models.openai import OpenAIChatCompletionClient
from autogen_core.models import ModelInfo # Import ModelInfo
from autogen_agentchat.teams import SelectorGroupChat
from autogen_core.models import UserMessage
from autogen_agentchat.conditions import TextMentionTermination, HandoffTermination
from services.azure_queue import get_queue_service
from services.redis_publisher import get_redis_publisher
from agents import get_agents

logger = logging.getLogger(__name__)


class TaskProcessor:
    """
    Core task processing logic that can be used by both worker and Azure Function App.
    """
    
    def __init__(self):
        self.o3_model_client = None
        self.o4_mini_model_client = None
        self.gpt41_model_client = None
        self.progress_tracker = None
        self.final_progress_sent = False
        
    async def initialize(self):
        """Initialize model clients and services."""
        import os
        from dotenv import load_dotenv
        load_dotenv()
        
        CORTEX_API_KEY = os.getenv("CORTEX_API_KEY")
        CORTEX_API_BASE_URL = os.getenv("CORTEX_API_BASE_URL", "http://host.docker.internal:4000/v1")

        # Define ModelInfo for custom models
        o3_model_info = ModelInfo(model="o3", name="Cortex o3", max_tokens=8192, cost_per_token=0.0, vision=False, function_calling=True, json_output=False, family="openai", structured_output=False) # Placeholder cost
        o4_mini_model_info = ModelInfo(model="o4-mini", name="Cortex o4-mini", max_tokens=128000, cost_per_token=0.0, vision=False, function_calling=True, json_output=False, family="openai", structured_output=False) # Placeholder cost
        gpt41_model_info = ModelInfo(model="gpt-4.1", name="Cortex gpt-4.1", max_tokens=8192, cost_per_token=0.0, vision=False, function_calling=True, json_output=False, family="openai", structured_output=False) # Placeholder cost

        self.o3_model_client = OpenAIChatCompletionClient(
            model="o3",
            api_key=CORTEX_API_KEY,
            base_url=CORTEX_API_BASE_URL,
            timeout=600,
            model_info=o3_model_info # Pass model_info
        )

        self.o4_mini_model_client = OpenAIChatCompletionClient(
            model="o4-mini",
            api_key=CORTEX_API_KEY,
            base_url=CORTEX_API_BASE_URL,
            timeout=600,
            model_info=o4_mini_model_info # Pass model_info
        )

        self.gpt41_model_client = OpenAIChatCompletionClient(
            model="gpt-4.1",
            api_key=CORTEX_API_KEY,
            base_url=CORTEX_API_BASE_URL,
            timeout=600,
            model_info=gpt41_model_info # Pass model_info
        )
        
        self.progress_tracker = await get_redis_publisher()

    async def summarize_progress(self, content: str, message_type: str = None, source: str = None) -> str:
        """Summarize progress content for display with intelligent filtering."""
        try:
            # Filter out technical/internal messages that shouldn't be shown to users
            if self._should_skip_progress_update(content, message_type, source):
                return None
            
            # Clean and prepare content for summarization
            cleaned_content = self._clean_content_for_progress(content, message_type, source)
            if not cleaned_content:
                return None
            
            prompt = f"""Generate a concise, engaging, and user-friendly progress update (5-15 words) that clearly indicates what the AI is currently working on. Include an appropriate emoji.

Context: This is for a user-facing progress indicator in a React app.

Current Activity: {cleaned_content}
Agent Source: {source if source else "Unknown"}

Requirements:
- Be positive and professional
- Focus on what the user will benefit from
- Avoid technical jargon
- Use engaging, action-oriented language
- Include a relevant emoji
- Consider the agent source to provide context (e.g., coder_agent = coding, presenter_agent = creating presentation)

Examples of good updates:
- "🔍 Researching the latest trends"
- "📊 Analyzing data patterns" 
- "🎨 Creating visual content"
- "📝 Compiling your report"
- "🚀 Finalizing results"
- "💻 Writing code for your request"
- "☁️ Uploading files to cloud storage"

Bad examples (avoid):
- "Task terminated"
- "Processing internal data"
- "Executing tool calls"
- "TERMINATE"

Generate only the progress update:"""
            
            messages = [UserMessage(content=str(prompt), source="summarize_progress_function")]
            
            response = await self.gpt41_model_client.create(messages=messages)
            return response.content.strip()
        except Exception as e:
            logging.error(f"Error in summarize_progress: {e}")
            return None

    def _should_skip_progress_update(self, content: str, message_type: str = None, source: str = None) -> bool:
        """Determine if a progress update should be skipped."""
        if not content:
            return True
            
        content_str = str(content).strip().upper()
        
        # Skip termination messages
        if content_str == "TERMINATE" or "TERMINATE" in content_str:
            return True
            
        # Skip empty or whitespace-only content
        if not content_str or content_str.isspace():
            return True
            
        # Skip technical tool execution messages
        if message_type == "ToolCallExecutionEvent":
            return True
            
        # Skip messages from terminator agent
        if source == "terminator_agent":
            return True
            
        # Skip JSON responses that are just data
        try:
            json.loads(content_str)
            # If it's valid JSON, it's probably technical data
            return True
        except:
            pass
            
        return False

    def _clean_content_for_progress(self, content: str, message_type: str = None, source: str = None) -> str:
        """Clean and prepare content for progress summarization."""
        if not content:
            return None
            
        content_str = str(content)
        
        # Remove common technical prefixes/suffixes
        technical_patterns = [
            "TERMINATE",
            "TASK NOT COMPLETED:",
            "Error:",
            "Warning:",
            "DEBUG:",
            "INFO:",
            "Tool call:",
            "Function call:",
        ]
        
        cleaned = content_str
        for pattern in technical_patterns:
            cleaned = cleaned.replace(pattern, "").strip()
            
        # If content is too short after cleaning, skip it
        if len(cleaned) < 10:
            return None
            
        return cleaned

    async def handle_progress_update(self, task_id: str, percentage: float, content: str, message_type: str = None, source: str = None):
        """Handle progress updates with intelligent summarization."""
        summarized_content = await self.summarize_progress(content, message_type, source)
        
        # Only publish if we have meaningful content
        if summarized_content:
            await self.progress_tracker.publish_progress(task_id, percentage, summarized_content)

    async def publish_final(self, task_id: str, message: str, data: Any = None) -> None:
        """Publish a final 1.0 progress message once."""
        if self.final_progress_sent:
            return
        try:
            if self.progress_tracker:
                final_data = message if data is None else data
                await self.progress_tracker.publish_progress(task_id, 1.0, message, data=final_data)
                self.final_progress_sent = True
        except Exception as e:
            logger.error(f"❌ Failed to publish final progress for task_id={task_id}: {e}")

    async def process_task(self, task_id: str, task_content: str) -> str:
        """Process a single task and return the final result."""
        try:
            task_completed_percentage = 0.05
            task = task_content

            # Send initial progress update
            await self.progress_tracker.publish_progress(task_id, 0.05, "🚀 Starting your task...")

            termination = HandoffTermination(target="user") | TextMentionTermination("TERMINATE")

            agents, presenter_agent = await get_agents(
                self.gpt41_model_client,
                self.o3_model_client,
                self.gpt41_model_client
            )

            team = SelectorGroupChat(
                participants=agents,
                model_client=self.gpt41_model_client,
                termination_condition=termination,
                max_turns=10000
            )

            messages = []
            uploaded_file_urls = {}
            final_result_content = []

            detailed_task = f"""
            Accomplish and present your task to the user in a great way, Markdown, it ll be shown in a React app that supports markdown.
            Task: 
            {task}
            """

            stream = team.run_stream(task=task)
            async for message in stream:
                messages.append(message)
                source = message.source if hasattr(message, 'source') else None
                content = message.content if hasattr(message, 'content') else None 
                created_at = message.created_at if hasattr(message, 'created_at') else None
                logger.info(f"\n\n#SOURCE: {source}\n#CONTENT: {content}\n#CREATED_AT: {created_at}\n")
                
                task_completed_percentage += 0.01
                if task_completed_percentage >= 1.0:
                    task_completed_percentage = 0.99
                    
                if content:
                    processed_content_for_progress = content
                    if message.type == "ToolCallExecutionEvent" and hasattr(message, 'content') and isinstance(message.content, list):
                        error_contents = [res.content for res in message.content if hasattr(res, 'is_error') and res.is_error]
                        if error_contents:
                            processed_content_for_progress = "\n".join(error_contents)
                        else:
                            processed_content_for_progress = str(message.content)

                    if isinstance(content, str):
                        try:
                            json_content = json.loads(content)
                            if "download_url" in json_content and "blob_name" in json_content:
                                uploaded_file_urls[json_content["blob_name"]] = json_content["download_url"]
                                final_result_content.append(f"Uploaded file: [{json_content['blob_name']}]({json_content['download_url']})")
                        except json.JSONDecodeError:
                            pass
                    
                    final_result_content.append(str(content))
                    asyncio.create_task(self.handle_progress_update(task_id, task_completed_percentage, processed_content_for_progress, message.type, source))

            await self.progress_tracker.publish_progress(task_id, 0.95, "✨ Finalizing your results...")

            result_limited_to_fit = "\n".join(final_result_content)

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

            logger.info(f"🔍 TASK RESULT:\n{text_result}")
            final_data = text_result or "🎉 Your task is complete!"
            await self.progress_tracker.publish_progress(task_id, 1.0, "🎉 Your task is complete!", data=final_data)
            self.final_progress_sent = True
            
            return text_result
        except Exception as e:
            logger.error(f"❌ Error during process_task for {task_id}: {e}", exc_info=True)
            await self.publish_final(task_id, "❌ We hit an issue while working on your request. Processing has ended.")
            raise

    async def close(self):
        """Close all connections gracefully."""
        clients_to_close = [
            self.o3_model_client,
            self.o4_mini_model_client,
            self.gpt41_model_client
        ]

        for client in clients_to_close:
            model_name = "unknown_model"
            try:
                if hasattr(client, 'model'):
                    model_name = client.model
                elif hasattr(client, '__class__'):
                    model_name = client.__class__.__name__
            except Exception:
                pass
            
            try:
                logger.info(f"🔌 Attempting to close client session for {model_name}.")
                if client:
                    await client.close()
                logger.info(f"🔌 Successfully closed client session for {model_name}.")
            except Exception as e:
                logger.error(f"❌ Error closing client session for {model_name}: {e}")

        if self.progress_tracker:
            await self.progress_tracker.close()
            logger.info("🔌 Connections closed.")


async def process_queue_message(message_data: Dict[str, Any]) -> Optional[str]:
    """
    Process a single queue message and return the result.
    This is the main entry point for Azure Function App.
    """
    processor = TaskProcessor()
    try:
        task_id = message_data.get("id")
        await processor.initialize()
        
        raw_content = message_data.get("content") or message_data.get("message")

        if not raw_content:
            logger.error(f"❌ Message has no content: {message_data}")
            # Ensure terminal progress on empty content
            await processor.publish_final(task_id or "", "⚠️ Received an empty task. Processing has ended.")
            return None

        logger.debug(f"🔍 DEBUG: process_queue_message - Raw content received (first 100 chars): {raw_content[:100]}...")

        try:
            decoded_content = base64.b64decode(raw_content).decode('utf-8')
            task_data = json.loads(decoded_content)
            logger.debug(f"🔍 DEBUG: process_queue_message - Successfully base64 decoded and JSON parsed. Keys: {list(task_data.keys())}")
        except (json.JSONDecodeError, TypeError, ValueError) as e:
            logger.warning(f"⚠️ Failed to decode as base64, trying as raw JSON: {e}")
            try:
                task_data = json.loads(raw_content)
                logger.debug(f"🔍 DEBUG: process_queue_message - Successfully JSON parsed raw content. Keys: {list(task_data.keys())}")
            except json.JSONDecodeError as e2:
                logger.error(f"❌ Failed to parse message content as JSON after both attempts for message ID {task_id}: {e2}", exc_info=True)
                await processor.publish_final(task_id or "", "❌ Invalid task format received. Processing has ended.")
                return None

        task_content = task_data.get("message") or task_data.get("content")
        if not task_content:
            logger.error(f"❌ No valid task content (key 'message' or 'content') found in parsed data for message ID {task_id}: {task_data}")
            await processor.publish_final(task_id or "", "⚠️ No actionable task content found. Processing has ended.")
            return None

        logger.debug(f"🔍 DEBUG: process_queue_message - Extracted task_content (first 100 chars): {task_content[:100]}...")
        logger.info(f"📩 Processing task: {task_content[:100]}...")
        
        result = await processor.process_task(task_id, task_content)
        return result
        
    except Exception as e:
        logger.error(f"❌ Error processing task: {e}", exc_info=True)
        # Try to ensure a final progress is published even if initialization or processing failed
        try:
            if processor.progress_tracker is None:
                processor.progress_tracker = await get_redis_publisher()
            await processor.publish_final(message_data.get("id") or "", "❌ Task ended due to an unexpected error.")
        except Exception as publish_error:
            logger.error(f"❌ Failed to publish final error progress in exception handler: {publish_error}")
        raise
    finally:
        await processor.close() 