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
from autogen_core.models import UserMessage
from autogen_core import CancellationToken
from autogen_agentchat.teams import Swarm
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
from agents.util.agent_factory import get_agents
from agents.constants.data_validation import (
    EMPTY_DATA_VALIDATION_PRESENTER,
    FACTUAL_ACCURACY_VALIDATION
)
from agents.util.helpers import (
    build_dynamic_context_from_files,
    write_plan_to_file,
    append_accomplishment_to_file,
    write_current_step_to_file
)

# Import from refactored modules
from .message_utils import _stringify_content
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
            # NOTE: Initial "Starting your task..." message is now sent by function_app.py for lower latency
            # We keep this here just in case, but commented out or we can remove it.
            # Let's remove it to avoid duplicate messages.
            # await progress_handler.handle_progress_update(
            #     task_id, 0.05, "🚀 Starting your task..."
            # )

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
                task_content=task,
            )

            # Run the complete agent workflow - planner first
            result = await self._run_agent_workflow(
                task_id, task_with_context, request_work_dir,
                planner_agent, execution_agents, uploader_agent, presenter_agent,
                self.gpt41_model_client
            )

            return result

        except Exception as e:
            # Send final progress update for failures
            import traceback
            traceback.print_exc()
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
        planner_agent, execution_agents, uploader_agent, presenter_agent,
        model_client=None
    ) -> str:
        """Run the complete agent workflow: unified execution → upload → presentation."""
        print(f"DEBUG: _run_agent_workflow called for task {task_id}")
        # Get progress handler
        progress_handler = await self._get_progress_handler()

        # Start with unified execution team (all agents together)
        self.logger.info(f"🚀 Starting unified execution with all agents...")
        _log_context_to_request_file(task_id, "EXECUTION_START", f"Starting unified execution with task: {task[:200]}...")

        execution_context = await self._run_unified_execution_phase(task_id, task, work_dir, planner_agent, execution_agents, presenter_agent)
        self.logger.info(f"✅ Unified execution completed, result: {execution_context[:100] if execution_context else 'None'}...")

        # Phase 2: Upload & Present
        result = await self._run_upload_and_present_phase(
            task_id, task, work_dir, uploader_agent, presenter_agent, execution_context
        )

        return result




    async def _run_unified_execution_phase(self, task_id: str, task: str, work_dir: str,
                                 planner_agent, execution_agents, presenter_agent) -> str:
        """Run the execution phase with the agent team."""
        try:
            # Let SelectorGroupChat dynamically select agents based on improved descriptions

            # Get progress handler
            progress_handler = await self._get_progress_handler()

            # All agents participate - let AutoGen's SelectorGroupChat route dynamically
            # based on agent descriptions and conversation flow
            all_agents = [planner_agent] + execution_agents
            _log_context_to_request_file(task_id, "UNIFIED_TEAM", f"Starting unified team: {[a.name for a in all_agents]}, Task: {task[:100]}...")

            # Log agent descriptions for debugging
            for agent in all_agents:
                _log_context_to_request_file(task_id, "AGENT_DESC", f"{agent.name}: {agent.description}")

            # Use Swarm for better dynamic handoffs between agents
            # Order matters: planner_agent first, then execution agents (which includes verifier)
            # CRITICAL: Do NOT include presenter_agent in Swarm - it must run separately after execution
            # to avoid premature termination when __TASK_COMPLETELY_FINISHED__ is encountered
            swarm_participants = [planner_agent] + execution_agents


            execution_team = Swarm(
                participants=swarm_participants,
                termination_condition=TextMentionTermination("TERMINATE"),
                max_turns=100  # Reasonable limit to prevent infinite loops
            )

            # Run unified team
            stream = execution_team.run_stream(task=task)

            # Track execution progress incrementally - 1% per agent message
            # Start at 5% and increment for each agent message (5% -> 6% -> 7% -> ...)
            execution_progress = 0.05
            agent_message_count = 0  # Track agent messages for debugging
            last_progress_time = time.time()
            last_progress_message = "⏳ Processing task..."
            last_message = None  # Track the last message for replanning detection

            try:
                async for message in stream:
                    last_message = message  # Keep track of the last message
                    source = getattr(message, "source", None)
                    content = getattr(message, "content", None)

                    # Log every agent message for debugging
                    if source is not None and content is not None:
                        _log_context_to_request_file(task_id, "AGENT_MESSAGE", f"{source}: {content[:500]}...")
                        self.logger.info(f"🔍 Agent message: {source} - {content[:200]}...")

                        # Check for task completion
                        if "__TASK_COMPLETELY_FINISHED__" in content:
                            _log_context_to_request_file(task_id, "TASK_COMPLETE", f"Task completed by {source}")
                            self.logger.info(f"✅ TASK COMPLETE: Execution phase finished by {source}")

                        # Log potential handoff indicators
                        if "Handing off to" in content:
                            _log_context_to_request_file(task_id, "HANDOFF_ATTEMPT", f"{source} attempting handoff: {content}")
                            self.logger.info(f"🔄 HANDOFF ATTEMPT: {source} - {content[:100]}...")

                    # Send progress updates for every agent message
                    if source is not None:
                        agent_message_count += 1
                        execution_progress = round(min(execution_progress + 0.01, 0.93), 4)  # Cap at 93% (before 94% upload) and round
                        self.logger.debug(f"Agent message {agent_message_count}: execution_progress={execution_progress}")

                        # Generate progress message from actual agent content
                        # Clean and extract meaningful progress info from agent messages
                        progress_base = extract_progress_info(content, source)
                        progress_msg = await self.progress_generator.generate_progress_message(progress_base, source, task[:100], self.recent_progress_messages[-7:], request_id=task_id)
                        self.recent_progress_messages.append(progress_msg)
                        last_progress_message = progress_msg  # Update for heartbeat

                        # Send single progress update for agent message (auto-increment percentage)
                        await progress_handler.handle_progress_update(
                            task_id, 0.0, progress_msg  # Use 0.0 to trigger auto-increment
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
                # Properly close the async generator to prevent pending tasks
                if hasattr(stream, 'aclose'):
                    await stream.aclose()

            # Check if replanning was requested by execution_completion_verifier_agent
            if last_message and getattr(last_message, "source", None) == "execution_completion_verifier_agent":
                content = getattr(last_message, "content", "")
                if "REPLAN:" in str(content):
                    self.logger.info(f"🔄 Replanning requested for task {task_id}: {content}")
                    return f"REPLAN:{content}"  # Special return value to trigger replanning

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

    async def _run_presenter_agent(self, presenter_agent, context: str, work_dir: str) -> str:
        """Run the presenter agent to generate final response."""
        try:
            self.logger.info("🎨 Running presenter agent to generate final presentation")

            # Run the presenter agent directly (single agent, no team needed)
            # The agent is already configured with the correct system message and tools
            from autogen_agentchat.agents import AssistantAgent
            from autogen_core import CancellationToken

            if isinstance(presenter_agent, AssistantAgent):
                try:
                    # Run the agent to generate the presentation
                    # The system message ensures it outputs the final result correctly
                    task_result = await presenter_agent.run(
                        task=context,
                        cancellation_token=CancellationToken()
                    )
                    
                    # Get the final response from the agent
                    if task_result.messages:
                        # Log ALL messages for debugging
                        for i, msg in enumerate(task_result.messages):
                            self.logger.info(f"🎨 Presenter msg {i} ({type(msg).__name__}): {str(msg.content)[:200]}...")
                            
                        # The last message should contain the presentation
                        presentation_result = str(task_result.messages[-1].content)
                        self.logger.info(f"✅ Presenter agent completed, result length: {len(presentation_result)}")
                    else:
                        presentation_result = "Presenter agent produced no output."
                        
                except Exception as e:
                    self.logger.error(f"❌ Presenter agent failed: {e}")
                    raise e
            else:
                presentation_result = f"Presenter agent type not supported: {type(presenter_agent)}"

            # Clean up the result (remove termination markers if present)
            if "__TASK_COMPLETELY_FINISHED__" in presentation_result:
                presentation_result = presentation_result.replace("__TASK_COMPLETELY_FINISHED__", "").strip()
            
            # Ensure we have a valid result
            if not presentation_result:
                raise Exception("Presenter agent returned empty response")

            # Append termination marker for system compatibility
            if not presentation_result.endswith("__TASK_COMPLETELY_FINISHED__"):
                presentation_result = presentation_result + "\n\n__TASK_COMPLETELY_FINISHED__"

            return presentation_result

        except Exception as e:
            self.logger.error(f"❌ Presenter processing failed: {e}")
            raise

    async def _run_upload_and_present_phase(self, task_id: str, task: str, work_dir: str,
                                          uploader_agent, presenter_agent, execution_context: str = "") -> str:
        """Run upload and presentation phases using agents."""
        try:
            # Get progress handler
            progress_handler = await self._get_progress_handler()

            # 1. UPLOAD PHASE - Direct upload (simpler and more reliable)
            asyncio.create_task(progress_handler.handle_progress_update(
                task_id, 0.94, "📤 Uploading deliverables..."
            ))

            self.logger.info(f"📤 Directly uploading files for task {task_id} from {work_dir}")

            # Import the unified upload function
            from tools.azure_blob_tools import upload_files

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
                    upload_response = upload_files(all_files, work_dir)
                    self.logger.info(f"📤 Upload completed: {upload_response.get('total_uploaded', 0)} succeeded, {upload_response.get('total_failed', 0)} failed")

                    # Clean up duplicate URLs
                    if "uploads" in upload_response and isinstance(upload_response["uploads"], list):
                        seen_urls = set()
                        filtered_uploads = []
                        for upload in upload_response["uploads"]:
                            download_url = upload.get("download_url", "")
                            if download_url and download_url not in seen_urls:
                                seen_urls.add(download_url)
                                filtered_uploads.append(upload)

                        upload_response["uploads"] = filtered_uploads
                        self.logger.info(f"📤 After filtering: {len(filtered_uploads)} unique files")

                    upload_response_text = json.dumps(upload_response)
                else:
                    raise Exception(f"No deliverable files found in {work_dir}")
            else:
                raise Exception(f"Work directory does not exist: {work_dir}")

            self.logger.info(f"📤 Upload response length: {len(upload_response_text)}")

            # 2. PRESENTATION PHASE - Use Presenter Agent
            present_msg = "✨ Finalizing your results..."
            self.recent_progress_messages.append(present_msg)
            await progress_handler.handle_progress_update(
                task_id, 0.95, present_msg
            )

            # PRE-READ CSV DATA for context (Fixes missing table preview issue)
            csv_previews = ""
            file_summary_context = "**CREATED FILES SUMMARY:**\n"
            
            try:
                import glob
                import pandas as pd
                
                # Parse upload response to get download links
                upload_map = {}
                try:
                    upload_data = json.loads(upload_response_text)
                    if "uploads" in upload_data:
                        for upload in upload_data["uploads"]:
                            fname = upload.get("filename", "")
                            if fname:
                                upload_map[fname] = upload.get("download_url", "")
                except:
                    pass

                # Process CSVs for previews
                csv_files = glob.glob(os.path.join(work_dir, "*.csv"))
                if csv_files:
                    csv_previews = "\n\n**DATA PREVIEWS (Use these to create markdown tables):**\n"
                    for csv_file in csv_files:
                        filename = os.path.basename(csv_file)
                        download_link = upload_map.get(filename, "Link not available")
                        file_summary_context += f"- CSV File: {filename} (Link: {download_link})\n"
                        
                        try:
                            # Read first 15 rows
                            df = pd.read_csv(csv_file, nrows=15)
                            columns = list(df.columns)
                            file_summary_context += f"  - Columns: {columns}\n"
                            
                            csv_content = df.to_markdown(index=False)
                            csv_previews += f"\nFile: {filename}\nColumns: {columns}\n{csv_content}\n"
                        except Exception as e:
                            self.logger.warning(f"Failed to read CSV {filename} for preview: {e}")
                
                # Add other files to summary
                other_files = glob.glob(os.path.join(work_dir, "*"))
                for f in other_files:
                    fname = os.path.basename(f)
                    if not fname.endswith('.csv') and not fname.startswith('.'):
                        download_link = upload_map.get(fname, "Link not available")
                        file_summary_context += f"- File: {fname} (Link: {download_link})\n"

            except Exception as e:
                self.logger.warning(f"Failed to generate file summaries: {e}")

            # Create context for presenter agent
            presenter_context = f"""
Task: {task}
Work Directory: {work_dir}
Upload Results: {upload_response_text}
Execution Context: {execution_context}

{file_summary_context}

{csv_previews}

**CRITICAL INSTRUCTIONS**:
1. Parse the Upload Results using your tool to get download links.
2. **DISPLAY A MARKDOWN TABLE** of the data using the "DATA PREVIEWS" provided above.
3. Provide insights based on the data.
4. Include the download links.

You MUST show the data preview table.
"""

            # Run presenter agent
            final_result = await self._run_presenter_agent(presenter_agent, presenter_context, work_dir)

            # Strip termination string if present
            if final_result:
                final_result = final_result.replace("__TASK_COMPLETELY_FINISHED__", "").strip()

            # Send final progress update
            await progress_handler.handle_progress_update(
                task_id, 1.0, "🎉 Your task is complete!",
                data=final_result
            )

            return final_result

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


async def process_queue_message(message_data: Dict[str, Any], logger=None) -> Optional[str]:
    """
    Main entry point for processing queue messages.

    This function supports per-request loggers for parallel execution.
    """
    try:
        # Create a per-request TaskProcessor instance with its own logger
        processor = TaskProcessor(logger=logger)

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