"""
Task Processor - Main entry point for processing tasks with AI agents.

This module has been refactored from a monolithic 1800+ line file into smaller,
focused modules for better maintainability.
"""
import asyncio
import json
import logging
import os
import re
import time
from typing import Optional, Dict, Any, List, Sequence
from autogen_ext.models.openai import OpenAIChatCompletionClient
from autogen_core.models import ModelInfo
from autogen_agentchat.messages import TextMessage, BaseAgentEvent, BaseChatMessage
from autogen_agentchat.teams import SelectorGroupChat
from autogen_agentchat.conditions import TextMentionTermination
from services.azure_queue import get_queue_service
from services.redis_publisher import get_redis_publisher
from services.azure_ai_search import search_similar_rest, upsert_run_rest
from services.run_analyzer import (
    collect_run_metrics,
    extract_errors,
    redact,
    summarize_learnings,
    build_run_document,
    summarize_prior_learnings,
)
from agents import (
    get_agents,
    EMPTY_DATA_VALIDATION_PRESENTER,
    FACTUAL_ACCURACY_VALIDATION,
    build_dynamic_context_from_files,
    write_plan_to_file,
    append_accomplishment_to_file,
    write_current_step_to_file
)

# Import from refactored modules
from .message_utils import (
    _message_to_dict,
    _stringify_content,
    _coerce_message_object,
    _wrap_json_if_needed,
    _normalize_single_message
)
from .model_client import RoleFixingModelClientWrapper
from .model_config import ModelConfig
from .progress_handler import ProgressHandler
from .progress_utils import ProgressMessageGenerator, extract_progress_info

logger = logging.getLogger(__name__)

# Global variable to hold the current runner logger for parallel test execution
_current_runner_logger = None

def set_current_runner_logger(runner_logger):
    """Set the current runner logger for parallel test execution."""
    global _current_runner_logger
    _current_runner_logger = runner_logger

def get_current_runner_logger():
    """Get the current runner logger for parallel test execution."""
    global _current_runner_logger
    return _current_runner_logger


class TaskProcessor:
    """
    Main processor for handling AI agent tasks with progress tracking and result publishing.
    """

    def __init__(self, logger=None, debug_progress_msgs=False):
        """Initialize the task processor with required services."""
        self.queue_service = get_queue_service()
        self.redis_publisher = None  # Will be initialized lazily

        self.logger = logger or logging.getLogger(__name__)  # Use provided logger or default
        self.debug_progress_msgs = debug_progress_msgs  # Control detailed agent progress messages

        # Initialize model clients using centralized configuration
        self.gpt41_model_client = ModelConfig.create_model_client("gpt-4.1")
        self.o3_model_client = ModelConfig.create_model_client("o3")

        # Initialize progress handler and message generator after model clients
        self.progress_handler = None
        self.progress_generator = ProgressMessageGenerator(model_client=self.gpt41_model_client)
        self.recent_progress_messages = []  # Track recent progress messages for context

        # Heartbeat emoji rotation
        self.heartbeat_emojis = ["🔄", "🔁"]
        self.heartbeat_emoji_index = 0
        self.heartbeat_interval = 1.0  # Send heartbeat every 1 second

    async def _get_redis_publisher(self):
        """Lazily initialize and return Redis publisher."""
        if self.redis_publisher is None:
            self.redis_publisher = await get_redis_publisher()
        return self.redis_publisher

    async def _get_progress_handler(self):
        """Lazily initialize and return progress handler."""
        if self.progress_handler is None:
            redis_pub = await self._get_redis_publisher()
            self.progress_handler = ProgressHandler(redis_pub, self.gpt41_model_client)
        return self.progress_handler

    async def process_task(self, task_id: str, task_content: str, runner_info: dict = None) -> str:
        """
        Process a single task through the AI agent workflow.

        Args:
            task_id: Unique identifier for the task
            task_content: The task description/content

        Returns:
            Final result string
        """
        try:

            # Initialize progress handler
            progress_handler = await self._get_progress_handler()

            # Extract and normalize the task content
            task = self._extract_task_content(task_content)
            self.logger.info(f"🎯 Processing task {task_id}: {task[:100]}...")

            # Send immediate progress update to show task started
            await progress_handler.handle_progress_update(
                task_id, 0.05, "🚀 Starting your task..."
            )

            # Initialize progress - continue with planning at 5%

            # Build dynamic context from files
            request_work_dir = f"/tmp/coding/req_{task_id}"
            os.makedirs(request_work_dir, exist_ok=True)

            context_files = build_dynamic_context_from_files(request_work_dir, task)
            task_with_context = f"{task}\n\nContext from previous work:\n{context_files}"

            # Get agents for this task
            planner_agent, execution_agents, uploader_agent, presenter_agent = await get_agents(
                self.gpt41_model_client,
                self.o3_model_client,
                self.gpt41_model_client,
                request_work_dir=request_work_dir,
                request_id=task_id,
            )

            # Run the complete agent workflow
            result = await self._run_agent_workflow(
                task_id, task_with_context, request_work_dir,
                planner_agent, execution_agents, uploader_agent, presenter_agent
            )

            return result

        except Exception as e:
            # Send final progress update for failures
            try:
                progress_handler = await self._get_progress_handler()
                await progress_handler.handle_progress_update(
                    task_id, 1.0, f"❌ Task failed: {str(e)[:100]}..."
                )
            except Exception as progress_error:
                self.logger.debug(f"Failed to send failure progress update: {progress_error}")

            self.logger.error(f"❌ Task processing failed for {task_id}: {e}", exc_info=True)
            return f"Task failed: {str(e)}"

    def _extract_task_content(self, task_content: str) -> str:
        """Extract the actual task content from various input formats."""
        try:
            # Try to parse as JSON first
            parsed = json.loads(task_content)
            if isinstance(parsed, dict):
                # Handle nested content structures
                if isinstance(parsed.get("content"), dict):
                    content_obj = parsed["content"]
                    if "message" in content_obj:
                        return _stringify_content(content_obj["message"])
                    elif "request_id" in content_obj:
                        return _stringify_content(content_obj.get("content", ""))

                return _stringify_content(parsed.get("content", parsed.get("message", task_content)))
            return task_content
        except json.JSONDecodeError:
            return _stringify_content(task_content)

    async def _run_agent_workflow(
        self, task_id: str, task: str, work_dir: str,
        planner_agent, execution_agents, uploader_agent, presenter_agent
    ) -> str:
        """Run the complete agent workflow: planning → execution → upload → presentation."""
        # Get progress handler
        progress_handler = await self._get_progress_handler()

        # Phase 1: Planning
        planning_msg = await self.progress_generator.generate_progress_message("Creating your execution plan", "planner", task[:100], self.recent_progress_messages[-7:])
        self.recent_progress_messages.append(planning_msg)
        await progress_handler.handle_progress_update(
            task_id, 0.05, planning_msg
        )

        execution_task = await self._run_planning_phase(task_id, task, planner_agent)
        _log_context_to_request_file(task_id, "PLANNING_COMPLETE", f"Plan created and execution task prepared: {execution_task[:200]}...")

        # Phase 2: Execution
        _log_context_to_request_file(task_id, "EXECUTION_START", f"Starting execution with task: {execution_task[:200]}...")
        execution_context = await self._run_execution_phase(task_id, execution_task, work_dir, task, planner_agent, execution_agents)
        _log_context_to_request_file(task_id, "EXECUTION_COMPLETE", f"Execution completed with context: {execution_context[:200]}...")

        # Phase 3: Upload & Present
        result = await self._run_upload_and_present_phase(
            task_id, task, work_dir, uploader_agent, presenter_agent, execution_context
        )

        return result

    async def _run_planning_phase(self, task_id: str, task: str, planner_agent) -> str:
        """Run the planning phase to create an execution strategy."""
        try:
            self.logger.info(f"🎯 Starting planning phase for task: {task[:100]}...")
            # Run planner agent to create execution plan
            plan_messages = [
                TextMessage(content=f"""Create a detailed execution plan for this task.

Task: {task}

Provide a step-by-step plan that agents can follow to complete this task successfully.
Include which agents should be used and what each should accomplish.""",
                           source="system")
            ]

            plan_result = await planner_agent.on_messages(plan_messages, cancellation_token=None)
            if plan_result and hasattr(plan_result, 'chat_message'):
                plan_content = plan_result.chat_message.content if hasattr(plan_result.chat_message, 'content') else ""
                self.logger.info(f"📋 Plan created for task {task_id}")

                # Save plan to file for context
                write_plan_to_file(f"/tmp/coding/req_{task_id}", plan_content)

                # Return task with plan
                return f"{task}\n\nExecution Plan:\n{plan_content}"
            else:
                return task
        except Exception as e:
            self.logger.warning(f"Planning phase failed: {e}")
            return task

    async def _run_execution_phase(self, task_id: str, execution_task: str, work_dir: str, task: str,
                                 planner_agent, execution_agents) -> str:
        """Run the execution phase with the agent team."""
        try:
            # Let SelectorGroupChat dynamically select agents based on improved descriptions

            # Get progress handler
            progress_handler = await self._get_progress_handler()

            # Define execution selector function
            def execution_selector_func(messages: Sequence[BaseAgentEvent | BaseChatMessage]) -> str | None:
                """Selector function for execution phase routing - LLM-guided dynamic selection."""
                if not messages:
                    return None  # Let SelectorGroupChat choose based on agent descriptions

                last_message = messages[-1]
                source = getattr(last_message, "source", None)
                content = getattr(last_message, "content", None)

                # Log message for debugging
                _log_message_to_request_file(task_id, last_message)

                # Only intervene for specific content patterns that require routing
                if source == "coder_agent" and content and "```python" in str(content):
                    self.logger.info("🎯 Selector: coder_agent provided code; routing to code_executor")
                    return "code_executor"

                if source == "code_executor" and content and "Ready for upload" in str(content):
                    self.logger.info("🎯 Selector: code_executor reported files ready; routing to execution_completion_verifier_agent")
                    return "execution_completion_verifier_agent"

                if source == "execution_completion_verifier_agent" and content and "TERMINATE" in str(content):
                    self.logger.info("🎯 Selector: execution completed; terminating")
                    return None

                return None  # Let SelectorGroupChat handle agent selection based on descriptions

            # Always start with planner_agent, let SelectorGroupChat dynamically select agents based on descriptions
            starting_agents = [planner_agent] + execution_agents
            _log_context_to_request_file(task_id, "SELECTOR_START_AGENTS", f"Starting agents: {[a.name for a in starting_agents]}")

            # Create execution team
            execution_team = SelectorGroupChat(
                participants=starting_agents,
                model_client=self.gpt41_model_client,
                selector_func=execution_selector_func,
                termination_condition=TextMentionTermination("TERMINATE")
            )

            # Run execution team
            stream = execution_team.run_stream(task=execution_task)

            # Track execution progress incrementally - 1% per agent message
            # Start at 5% and increment for each agent message (5% -> 6% -> 7% -> ...)
            execution_progress = 0.05
            last_progress_time = time.time()
            last_progress_message = "Starting execution phase"
            heartbeat_task = None

            # Start heartbeat task to send progress updates every 2 seconds
            async def heartbeat_worker():
                while True:
                    await asyncio.sleep(self.heartbeat_interval)  # Send heartbeat every configured interval
                    current_time = time.time()
                    if current_time - last_progress_time >= self.heartbeat_interval:  # Only send if no progress for interval+ seconds
                        try:
                            # # Create heartbeat message by appending rotating continuity emoji
                            # heartbeat_emoji = self.heartbeat_emojis[self.heartbeat_emoji_index % len(self.heartbeat_emojis)]
                            # heartbeat_msg = f"{last_progress_message} {heartbeat_emoji}"
                            # # Rotate to next emoji
                            # self.heartbeat_emoji_index += 1

                            #override heartbeat for now to only msg no emoji
                            heartbeat_msg = f"{last_progress_message}"

                            await progress_handler.handle_progress_update(
                                task_id, execution_progress, heartbeat_msg,
                                is_heartbeat=True,
                            )
                            self.logger.debug(f"💓 Heartbeat: {heartbeat_msg}")
                        except Exception as e:
                            self.logger.error(f"❌ Heartbeat failed: {e}")

            # Start heartbeat background task
            heartbeat_task = asyncio.create_task(heartbeat_worker())

            try:
                async for message in stream:
                    source = getattr(message, "source", None)
                    content = getattr(message, "content", None)

                    # Send progress updates for every agent message
                    if source is not None:
                        execution_progress = round(min(execution_progress + 0.01, 0.93), 4)  # Cap at 93% (before 94% upload) and round

                        # Generate progress message from actual agent content
                        # Clean and extract meaningful progress info from agent messages
                        progress_base = extract_progress_info(content, source)
                        progress_msg = await self.progress_generator.generate_progress_message(progress_base, source, task[:100], self.recent_progress_messages[-7:])
                        self.recent_progress_messages.append(progress_msg)
                        last_progress_message = progress_msg  # Update for heartbeat

                        # Send progress update for agent message
                        await progress_handler.handle_progress_update(
                            task_id, execution_progress, progress_msg
                        )
                        # Send progress update for agent messages so test framework can capture agent sequence
                        if self.debug_progress_msgs:
                            # Detailed debug message for development/testing
                            agent_progress_msg = f"📊 Agent message progress: {execution_progress:.0%} - {source} - '{progress_base}'"
                            await progress_handler.handle_progress_update(
                                task_id, execution_progress, agent_progress_msg
                            )
                        else:
                            # Clean user-friendly progress message using LLM
                            clean_progress_base = extract_progress_info(content, source)
                            agent_progress_msg = await self.progress_generator.generate_progress_message(
                                clean_progress_base, source, task[:100], self.recent_progress_messages[-7:]
                            )
                            self.recent_progress_messages.append(agent_progress_msg)
                            await progress_handler.handle_progress_update(
                                task_id, execution_progress, agent_progress_msg
                            )

                        # Also log to Docker logs (always detailed for debugging)
                        self.logger.info(f"📊 Agent message progress: {execution_progress:.0%} - {source} - '{progress_base}'")

                    # Update heartbeat timer for every message
                    last_progress_time = time.time()

                    # Log progress
                    if source and content:
                        append_accomplishment_to_file(work_dir, f"{source}: {str(content)[:200]}...")
                        write_current_step_to_file(work_dir, f"{source} processing", source)
            finally:
                # Cancel heartbeat task when execution finishes
                if heartbeat_task and not heartbeat_task.done():
                    heartbeat_task.cancel()
                    try:
                        await heartbeat_task
                    except asyncio.CancelledError:
                        pass

            # Collect execution context for presenter agent
            execution_context = self._collect_execution_context(work_dir)

            self.logger.info(f"✅ Execution phase completed for task {task_id}")
            return execution_context

        except Exception as e:
            self.logger.error(f"❌ Execution phase failed for {task_id}: {e}")
            raise

    def _collect_execution_context(self, work_dir: str) -> str:
        """Collect execution context from accomplishment files for presenter agent."""
        context_parts = []

        # Read accomplishments file
        accomplishments_file = os.path.join(work_dir, "accomplishments.txt")
        if os.path.exists(accomplishments_file):
            try:
                with open(accomplishments_file, 'r', encoding='utf-8') as f:
                    accomplishments = f.read().strip()
                    if accomplishments:
                        context_parts.append(f"**EXECUTION ACCOMPLISHMENTS**:\n{accomplishments}")
            except Exception as e:
                self.logger.warning(f"Failed to read accomplishments file: {e}")

        # Read current step file
        current_step_file = os.path.join(work_dir, "current_step.txt")
        if os.path.exists(current_step_file):
            try:
                with open(current_step_file, 'r', encoding='utf-8') as f:
                    current_step = f.read().strip()
                    if current_step:
                        context_parts.append(f"**CURRENT EXECUTION STATUS**:\n{current_step}")
            except Exception as e:
                self.logger.warning(f"Failed to read current step file: {e}")

        # Read plan file
        plan_file = os.path.join(work_dir, "plan.txt")
        if os.path.exists(plan_file):
            try:
                with open(plan_file, 'r', encoding='utf-8') as f:
                    plan = f.read().strip()
                    if plan:
                        context_parts.append(f"**EXECUTION PLAN**:\n{plan}")
            except Exception as e:
                self.logger.warning(f"Failed to read plan file: {e}")

        return "\n\n".join(context_parts) if context_parts else "No execution context available."

    async def _run_upload_and_present_phase(self, task_id: str, task: str, work_dir: str,
                                          uploader_agent, presenter_agent, execution_context: str = "") -> str:
        """Run upload and presentation phases."""
        try:
            # Get progress handler
            progress_handler = await self._get_progress_handler()

            # Update progress - static message for uploading (fire-and-forget)
            asyncio.create_task(progress_handler.handle_progress_update(
                task_id, 0.94, "📤 Uploading deliverables..."
            ))

            # Directly upload files instead of using uploader agent
            self.logger.info(f"📤 Directly uploading files for task {task_id} from {work_dir}")

            # Import the upload function
            from tools.azure_blob_tools import upload_files_to_azure_blob

            # Get list of files in work directory
            import os
            if os.path.exists(work_dir):
                all_files = []
                for root, dirs, files in os.walk(work_dir):
                    for file in files:
                        # Filter for deliverable files
                        if file.endswith(('.csv', '.png', '.pdf', '.pptx', '.xlsx', '.jpg', '.jpeg', '.txt')):
                            # Skip temporary files
                            if not (file.startswith('tmp_code_') or file.startswith('__pycache__') or file.endswith('.pyc')):
                                full_path = os.path.join(root, file)
                                all_files.append(full_path)
                                self.logger.info(f"📁 Found deliverable file: {full_path}")

                if all_files:
                    self.logger.info(f"📤 Uploading {len(all_files)} files...")
                    upload_response = upload_files_to_azure_blob(all_files, work_dir)
                    self.logger.info(f"📤 Upload completed, response length: {len(upload_response)}")

                    # Filter out duplicate image URLs to prevent presenter agent from showing duplicates
                    try:
                        import json
                        upload_data = json.loads(upload_response)
                        self.logger.info(f"📤 Original upload response has {len(upload_data.get('uploads', []))} files")
                        if "uploads" in upload_data and isinstance(upload_data["uploads"], list):
                            seen_urls = set()
                            filtered_uploads = []
                            duplicates_found = 0
                            for upload in upload_data["uploads"]:
                                download_url = upload.get("download_url", "")
                                if download_url and download_url not in seen_urls:
                                    seen_urls.add(download_url)
                                    filtered_uploads.append(upload)
                                else:
                                    duplicates_found += 1
                                    self.logger.warning(f"📤 FILTERED OUT duplicate URL: {download_url}")

                            upload_data["uploads"] = filtered_uploads
                            upload_response = json.dumps(upload_data)
                            self.logger.info(f"📤 After filtering: {len(filtered_uploads)} unique files (removed {duplicates_found} duplicates)")
                    except Exception as filter_error:
                        self.logger.warning(f"Failed to filter duplicate URLs: {filter_error}")
                else:
                    self.logger.warning(f"❌ No deliverable files found in {work_dir}")
                    upload_response = '{"uploads": [], "error": "No deliverable files found"}'
            else:
                self.logger.error(f"❌ Work directory does not exist: {work_dir}")
                upload_response = '{"uploads": [], "error": "Work directory not found"}'

            # Update progress
            present_msg = await self.progress_generator.generate_progress_message("Creating your final presentation", "presenter", task[:100], self.recent_progress_messages[-7:])
            self.recent_progress_messages.append(present_msg)
            await progress_handler.handle_progress_update(
                task_id, 0.95, present_msg
            )

            # Check if upload was successful before passing upload_response
            upload_results_section = ""
            try:
                import json
                upload_data = json.loads(upload_response)
                if upload_data.get("uploads") and len(upload_data["uploads"]) > 0:
                    upload_results_section = f"""

**UPLOAD RESULTS**:
{upload_response}"""
                    self.logger.info(f"✅ Passing {len(upload_data['uploads'])} upload results to presenter")
                else:
                    self.logger.warning(f"⚠️ No successful uploads to pass to presenter: {upload_response}")
            except Exception as e:
                self.logger.warning(f"⚠️ Failed to parse upload_response, not passing to presenter: {e}")

            # Run presenter agent
            present_messages = [
                TextMessage(content=f"""{task}

**PRESENTATION PHASE (95%) - FINAL STEP**:
Create the final user presentation showing the results.{upload_results_section}""",
                           source="system")
            ]

            # Update progress - finalizing results (fire-and-forget)
            asyncio.create_task(progress_handler.handle_progress_update(
                task_id, 0.95, "✨ Finalizing your results..."
            ))

            self.logger.info(f"🎨 Calling presenter_agent for task {task_id} with upload_response length: {len(upload_response)}")

            # Read CSV data directly and include in prompt to prevent hallucination
            csv_data_content = ""
            if os.path.exists(work_dir):
                for root, dirs, files in os.walk(work_dir):
                    for file in files:
                        if file.endswith('.csv'):
                            file_path = os.path.join(root, file)
                            try:
                                with open(file_path, 'r', encoding='utf-8') as f:
                                    content = f.read()
                                    csv_data_content += f"\n=== CSV FILE: {file} ===\n{content[:2000]}\n"  # Limit to first 2000 chars
                                    self.logger.info(f"📊 Included CSV data for presenter: {file} ({len(content)} chars)")
                            except Exception as e:
                                self.logger.warning(f"Failed to read CSV file {file}: {e}")

            # Create message that includes the actual CSV data
            present_messages = [
                TextMessage(content=f"""Format this upload response into a professional HTML presentation with meaningful data insights.

**ORIGINAL TASK**: {task}

**EXECUTION CONTEXT**:
{execution_context}

**ACTUAL CSV DATA - ANALYZE THIS REAL DATA**:
{csv_data_content}

Upload Response JSON:
{upload_response}

Work Directory: {work_dir}

**CRITICAL**: Base ALL your analysis and conclusions on the ACTUAL CSV DATA provided above. Do NOT make up numbers or trends. Extract real totals, averages, and comparisons from the CSV data.""",
                           source="user")
            ]

            present_result = await presenter_agent.on_messages(present_messages, cancellation_token=None)
            if present_result and hasattr(present_result, 'chat_message'):
                final_result = present_result.chat_message.content if hasattr(present_result.chat_message, 'content') else ""
                self.logger.info(f"🎨 Presenter agent final result (length: {len(final_result)}): {final_result[:300]}...")

                # Send final progress update WITH the result data
                await progress_handler.handle_progress_update(
                    task_id, 1.0, "🎉 Your task is complete!",
                    data=final_result  # Include the actual result data
                )

                self.logger.info(f"✅ Presentation completed for task {task_id}")
                return final_result
            else:
                return "Task completed but presentation failed"

        except Exception as e:
            self.logger.error(f"❌ Upload/presentation phase failed for {task_id}: {e}")
            return f"Task completed with errors: {str(e)}"


# Global processor instance
_processor_instance = None

async def get_task_processor(debug_progress_msgs: bool = None) -> TaskProcessor:
    """Get or create the global task processor instance."""
    global _processor_instance
    if _processor_instance is None:
        # Check environment variable, default to False
        if debug_progress_msgs is None:
            import os
            debug_progress_msgs = os.environ.get('DEBUG_PROGRESS_MSGS', 'false').lower() == 'true'
        _processor_instance = TaskProcessor(debug_progress_msgs=debug_progress_msgs)
    return _processor_instance


async def process_queue_message(message_data: Dict[str, Any]) -> Optional[str]:
    """
    Main entry point for processing queue messages.

    This function maintains backward compatibility with the original monolithic design.
    """
    try:
        processor = await get_task_processor()

        # Extract task information
        raw_content = message_data.get("content", message_data.get("message", ""))

        if not raw_content:
            processor.logger.warning("No task content found in message")
            return None

        # Use Azure Queue message ID for progress tracking (this is what the client expects)
        task_id = message_data.get("id", "unknown")
        task_content = raw_content  # Pass the full JSON content

        # Check for runner info for parallel test logging
        runner_info = message_data.get("runner_info", {})
        runner_id = runner_info.get("runner_id", 0)
        test_case_id = runner_info.get("test_case_id", "unknown")

        processor.logger.info(f"🎯 Processing task {task_id} (runner {runner_id}, test {test_case_id})")

        # Process the task
        result = await processor.process_task(task_id, task_content, runner_info=runner_info)

        processor.logger.info(f"✅ Task {task_id} completed successfully")
        return result

    except Exception as e:
        # Use module logger if processor is not available
        error_logger = processor.logger if 'processor' in locals() else logger
        error_logger.error(f"❌ Failed to process queue message: {e}", exc_info=True)
        return f"Processing failed: {str(e)}"


def _log_message_to_request_file(task_id: str, message) -> None:
    """Log all messages to per-request messages.log for debugging."""
    try:
        import os
        from datetime import datetime

        work_dir = f"/tmp/coding/req_{task_id}"
        os.makedirs(work_dir, exist_ok=True)

        messages_log_path = os.path.join(work_dir, "messages.log")

        timestamp = datetime.now().isoformat()
        source = getattr(message, "source", "unknown")
        content = getattr(message, "content", "")

        log_entry = f"[{timestamp}] {source}: {content}\n"

        with open(messages_log_path, "a", encoding="utf-8") as f:
            f.write(log_entry)

    except Exception as e:
        logger.warning(f"Failed to log message: {e}")


def _log_context_to_request_file(task_id: str, context_type: str, context_data: str) -> None:
    """Log context information to per-request context.log."""
    try:
        import os
        from datetime import datetime

        work_dir = f"/tmp/coding/req_{task_id}"
        os.makedirs(work_dir, exist_ok=True)

        context_log_path = os.path.join(work_dir, "context.log")

        timestamp = datetime.now().isoformat()
        log_entry = f"[{timestamp}] {context_type}: {context_data}\n"

        with open(context_log_path, "a", encoding="utf-8") as f:
            f.write(log_entry)

    except Exception as e:
        logger.warning(f"Failed to log context: {e}")