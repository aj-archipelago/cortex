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
import shutil
import time
from pathlib import Path
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

from .simple_workflow import SimplifiedWorkflow

from services.run_analyzer import (
    collect_run_metrics,
    extract_errors,
    redact,
    summarize_learnings,
    build_run_document,
    summarize_prior_learnings,
)
from dynamic_agent_loader import agent_factory, constants, helpers, get_agents
from context.context_memory import ContextMemory

# Import from refactored modules
from .message_utils import _stringify_content
from .model_config import ModelConfig


# Custom exception for workflow coordination failures
class WorkflowError(Exception):
    """Raised when agent workflow coordination fails (e.g., missing expected files, agent handoff failures)."""
    pass


def _check_files_exist(work_dir: str, expected_files: List[str]) -> tuple[bool, List[str]]:
    """Check if expected files exist and are non-empty.
    
    Returns:
        (success, missing_files): success is True if all files exist and non-empty
    """
    missing = []
    for filename in expected_files:
        filepath = os.path.join(work_dir, filename)
        if not os.path.exists(filepath):
            missing.append(f"{filename} (not found)")
        elif os.path.getsize(filepath) == 0:
            missing.append(f"{filename} (empty)")
    return len(missing) == 0, missing
from .progress_handler import ProgressHandler


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

        self.gpt5_mini_model_client = ModelConfig.create_model_client("gpt-5-mini")
        self.gpt5_model_client = ModelConfig.create_model_client("gpt-5")

        self.gpt51_model_client = ModelConfig.create_model_client("gpt-5.1")
        self.gpt51_chat_model_client = ModelConfig.create_model_client("gpt-5.1-chat")

        # Initialize progress handler and message generator after model clients
        self.progress_handler = None
        self.recent_progress_messages = []  # Track recent progress messages for context

        # Context memory for structured event tracking
        self.context_memory = None

        # Heartbeat emoji rotation
        self.heartbeat_emojis = ["🔄", "🔁"]
        self.heartbeat_emoji_index = 0

    async def initialize(self):
        """Initialize async services."""
        # Pre-initialize redis publisher and progress handler
        if self.redis_publisher is None:
            self.redis_publisher = await get_redis_publisher()
        if self.progress_handler is None:
            from .progress_handler import ProgressHandler
            self.progress_handler = ProgressHandler(self.redis_publisher, 
                #self.gpt41_model_client
                self.gpt51_model_client
                # self.gpt5_mini_model_client
                # self.gpt5_model_client
            )
        self.logger.info("✅ TaskProcessor initialized successfully")

    async def close(self):
        """Clean up async services."""
        if self.redis_publisher:
            await self.redis_publisher.close()
        self.logger.info("🔌 TaskProcessor connections closed")

    def _format_workflow_error_for_user(self, error: str) -> str:
        """Convert technical workflow errors to user-friendly messages."""
        if "No deliverable files found" in error:
            return ("Unable to create the requested files. The system couldn't generate "
                    "the required outputs. This may be due to data access issues or processing errors.")
        elif "aj_sql_agent" in error.lower():
            return "Database query failed. Couldn't fetch required data from Al Jazeera database."
        elif "web_search_agent" in error.lower():
            return "Web search failed. Couldn't gather required information from external sources."
        elif "coder_agent" in error.lower():
            return "File generation failed. The system encountered an error creating output files."
        # Include partial technical details for debugging
        return f"Task could not be completed. {error[:200]}"

    def _extract_file_expectations_from_plan(self, plan_text: str) -> Dict[str, List[str]]:
        """Extract what files each agent is expected to create from plan text."""
        expectations = {}
        lines = plan_text.split('\n')
        current_agent = None
        
        for line in lines:
            # Detect agent mentions
            if 'aj_sql_agent' in line.lower():
                current_agent = 'aj_sql_agent'
            elif 'coder_agent' in line.lower():
                current_agent = 'coder_agent'
            elif 'web_search_agent' in line.lower():
                current_agent = 'web_search_agent'
                
            # Look for file mentions
            if current_agent and any(ext in line.lower() for ext in ['.csv', '.png', '.pdf', '.pptx', '.xlsx', '.json']):
                # Apply strict type filtering based on agent role to avoid false positives
                # e.g. "aj_sql_agent queries data for report.pdf" -> should not expect pdf from aj_sql_agent
                
                valid_extensions = []
                if current_agent == 'aj_sql_agent':
                    valid_extensions = ['.json'] # AJ SQL mostly produces JSON (intermediate)
                elif current_agent == 'web_search_agent':
                    valid_extensions = ['.json', '.txt'] # Research produces JSON/TXT
                else:
                    # Coder agent can produce anything
                    valid_extensions = ['.csv', '.png', '.pdf', '.pptx', '.xlsx', '.json', '.jpg', '.jpeg']

                # Extract filename - simple regex
                import re
                files = re.findall(r'[\w-]+\.(?:csv|png|pdf|pptx|xlsx|json|jpg|jpeg)', line, re.IGNORECASE)
                for f in files:
                    # Check if extension is valid for this agent
                    ext = '.' + f.split('.')[-1].lower()
                    if ext in valid_extensions:
                        if current_agent not in expectations:
                            expectations[current_agent] = []
                        if f not in expectations[current_agent]:
                            expectations[current_agent].append(f)
        
        return expectations

    def _validate_agent_created_files(self, agent_name: str, expected_files: List[str], work_dir: str) -> tuple[bool, List[str]]:
        """Check if agent created expected files."""
        missing = []
        for filename in expected_files:
            filepath = os.path.join(work_dir, filename)
            if not os.path.exists(filepath):
                missing.append(f"{filename} (not found)")
            elif os.path.getsize(filepath) == 0:
                missing.append(f"{filename} (empty)")
        
        success = len(missing) == 0
        if not success:
            self.logger.warning(f"⚠️ {agent_name} validation failed. Missing/empty files: {missing}")
        else:
            self.logger.info(f"✅ {agent_name} validation passed. All {len(expected_files)} files created.")
        
        return success, missing
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
            self.progress_handler = ProgressHandler(redis_pub, 
                #self.gpt41_model_client
                self.gpt51_model_client
                # self.gpt5_mini_model_client
                #self.gpt5_model_client
            )
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

            # Start heartbeat - sends instant 5% message and begins background loop
            # await progress_handler.start_heartbeat(task_id, "🚀 Starting your task...")

            # Extract and normalize the task content
            task = self._extract_task_content(task_content)
            self.logger.info(f"🎯 Processing task {task_id}: {task}")

            # Initialize progress - continue with planning at 5%

            # Build dynamic context from files
            request_work_dir = f"/tmp/coding/req_{task_id}"
            os.makedirs(request_work_dir, exist_ok=True)

            # Initialize context memory
            self.context_memory = ContextMemory(request_work_dir, self.gpt41_model_client, task_id)
            
            # Initialize cognitive journey tracking
            from context.cognitive_journey_mapper import get_cognitive_journey_mapper
            journey_mapper = get_cognitive_journey_mapper()
            journey_mapper.start_journey(task_id, ["planner_agent", "coder_agent", "web_search_agent", "presenter_agent"])

            context_files = helpers.build_dynamic_context_from_files(request_work_dir, task)
            task_with_context = f"{task}\n\nContext from previous work:\n{context_files}"

            # Retrieve learnings from Azure Cognitive Search
            from services.learning_service import get_learnings_for_task
            learnings = await get_learnings_for_task(task, task_id, self.gpt41_model_client, self.context_memory)

            # Get agents for this task
            planner_agent, execution_agents, presenter_agent = await get_agents(
                #self.gpt41_model_client,
                self.gpt51_model_client,
                # self.gpt5_mini_model_client,
                # self.gpt5_model_client,
                self.o3_model_client,
                #self.gpt41_model_client,
                self.gpt51_model_client,
                # self.gpt5_mini_model_client,
                # self.gpt5_model_client,
                request_work_dir=request_work_dir,
                request_id=task_id,
                task_content=task,
                planner_learnings=learnings,
            )

            # Extract execution completion verifier agent from execution_agents
            execution_completion_verifier_agent = None
            filtered_execution_agents = []
            for agent in execution_agents:
                if agent.name == "execution_completion_verifier_agent":
                    execution_completion_verifier_agent = agent
                else:
                    filtered_execution_agents.append(agent)

            result = await self._run_agent_workflow(
                task_id, task_with_context, request_work_dir,
                planner_agent, filtered_execution_agents, presenter_agent,
                execution_completion_verifier_agent, 
                self.gpt41_model_client
                # self.gpt5_model_client
            )

            return result

        except Exception as e:
            # Send final progress update for failures
            import traceback
            traceback_str = traceback.format_exc()
            traceback.print_exc()
            
            # Save traceback to file for debugging
            try:
                tb_path = f"/tmp/coding/traceback_{task_id}.txt"
                with open(tb_path, "w") as f:
                    f.write(traceback_str)
                self.logger.error(f"🔥 Traceback saved to {tb_path}")
            except Exception as tb_error:
                self.logger.error(f"Failed to save traceback: {tb_error}")

            try:
                progress_handler = await self._get_progress_handler()
                # SAFETY: Stop heartbeat before sending error message
                await progress_handler.stop_heartbeat(task_id)
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
        planner_agent, execution_agents, presenter_agent,
        execution_completion_verifier_agent, model_client=None
    ) -> str:
        """Run the complete agent workflow: unified execution → upload → presentation."""
        print(f"DEBUG: _run_agent_workflow called for task {task_id}")
        # Get progress handler
        progress_handler = await self._get_progress_handler()

        # Note: Heartbeat is started in simplified_workflow.run_workflow() which sends initial message

        # Use simplified workflow with SelectorGroupChat for intelligent routing
        simplified_workflow = SimplifiedWorkflow(
             # self.gpt41_model_client
             self.gpt51_model_client
            # self.gpt5_mini_model_client
            #self.gpt5_model_client
        )

        # Run the complete simplified workflow
        result = await simplified_workflow.run_workflow(
            task=task,
            planner_agent=planner_agent,
            execution_agents=execution_agents,
            presenter_agent=presenter_agent,
            execution_completion_verifier_agent=execution_completion_verifier_agent,
            task_id=task_id,
            work_dir=work_dir,
            progress_handler=progress_handler,
            context_memory=self.context_memory,
            model_client_for_processing=self.gpt41_model_client
        )
        
        # Complete cognitive journey tracking
        if self.context_memory:
            try:
                from context.cognitive_journey_mapper import get_cognitive_journey_mapper
                journey_mapper = get_cognitive_journey_mapper()
                journey_mapper.complete_journey(task_id, "completed" if "ERROR" not in str(result) else "failed")
            except Exception as e:
                logger.warning(f"Failed to complete cognitive journey: {e}")

        return result


        #########################################################
        #########################################################

        # Reference data system removed - use generic solutions that fetch data dynamically

        # Use task directly - no reference data augmentation needed

        # Planner phase
        plan_text = await self._run_planner_phase(task_id, task, work_dir, planner_agent)

        # Start unified execution (without planner chatter)
        self.logger.info(f"🚀 Starting unified execution with locked plan...")
        _log_context_to_request_file(task_id, "EXECUTION_START", f"Starting unified execution with task: {task[:200]}...")

        execution_context = await self._run_unified_execution_phase(task_id, task, work_dir, execution_agents, plan_text)

        # Allow a single replanning attempt if execution verifier explicitly requests it
        if isinstance(execution_context, str) and execution_context.startswith("REPLAN:"):
            self.logger.info(f"🔁 Replanning requested for task {task_id}")
            plan_text = await self._run_planner_phase(task_id, task, work_dir, planner_agent, replan_reason=execution_context)
            execution_context = await self._run_unified_execution_phase(task_id, task, work_dir, execution_agents, plan_text)
            if isinstance(execution_context, str) and execution_context.startswith("REPLAN:"):
                raise RuntimeError(f"Repeated replanning requested: {execution_context}")

        self.logger.info(f"✅ Unified execution completed, result: {execution_context[:100] if isinstance(execution_context, str) and execution_context else 'None'}...")

        # Phase 2: Upload & Present
        result = await self._run_upload_and_present_phase(
            task_id, task, work_dir, presenter_agent, execution_context, plan_text
        )

        return result



    async def _run_planner_phase(self, task_id: str, task: str, work_dir: str, planner_agent, replan_reason: str = "") -> str:
        """Run planner agent once to establish plan and deliverables checklist."""
        planner_task = task
        if replan_reason:
            planner_task = f"{task}\n\nThe previous execution attempt failed with the following issue:\n{replan_reason}\n\nCreate a corrected plan with a concrete Deliverables Checklist and explicit agent handoffs."

        self.logger.info(f"🧭 Running planner agent for task {task_id}")
        planner_result = await planner_agent.run(
            task=planner_task,
            cancellation_token=CancellationToken()
        )

        if not planner_result.messages:
            raise RuntimeError("Planner agent produced no output.")

        plan_text = str(planner_result.messages[-1].content)
        if not plan_text.strip():
            raise RuntimeError("Planner agent returned empty plan.")

        helpers.write_plan_to_file(work_dir, plan_text)
        _log_context_to_request_file(task_id, "PLANNER_PLAN", plan_text[:2000])
        
        # Record plan creation in context memory
        if self.context_memory:
            self.context_memory.record_agent_action(
                "planner_agent",
                "plan_creation",
                {"plan_preview": plan_text[:500]},
                {"plan_length": len(plan_text)},
                {}
            )
        
        return plan_text

    async def _run_unified_execution_phase(self, task_id: str, task: str, work_dir: str,
                                           execution_agents, plan_text: str) -> str:
        """Run the execution phase with the agent team."""
        try:
            # Let SelectorGroupChat dynamically select agents based on improved descriptions

            # Get progress handler
            progress_handler = await self._get_progress_handler()

            all_agents = execution_agents
            _log_context_to_request_file(task_id, "UNIFIED_TEAM", f"Starting unified team: {[a.name for a in all_agents]}, Task: {task[:100]}...")

            # Log agent descriptions for debugging
            for agent in all_agents:
                _log_context_to_request_file(task_id, "AGENT_DESC", f"{agent.name}: {agent.description}")

            swarm_participants = execution_agents

            # DEBUG: Log swarm participants to help diagnose speaker selection issues
            participant_names = [p.name for p in swarm_participants]
            _log_context_to_request_file(task_id, "SWARM_PARTICIPANTS", f"Swarm participants: {participant_names}")
            self.logger.info(f"🐝 Swarm participants: {participant_names}")

            execution_team = Swarm(
                participants=swarm_participants,
                termination_condition=TextMentionTermination("TERMINATE"),
                max_turns=500  # Reasonable limit to prevent infinite loops
            )

            # Generate focused context summary for execution agents
            focused_context_summary = ""
            if self.context_memory:
                try:
                    # Generate a general execution context summary (for all agents)
                    # Use a default agent name to get general context
                    focused_context_summary = await self.context_memory.get_focused_agent_context(
                        "coder_agent",  # Use coder_agent as default for general context
                        "Starting execution phase",
                        max_tokens=3000
                    )
                except Exception as e:
                    self.logger.warning(f"Failed to generate focused context summary: {e}")
                    focused_context_summary = ""

            execution_task = (
                f"{task}\n\n"
                "=== LOCKED EXECUTION PLAN ===\n"
                f"{plan_text}\n\n"
            )
            
            if focused_context_summary:
                execution_task += (
                    "=== EXECUTION CONTEXT SUMMARY ===\n"
                    f"{focused_context_summary}\n\n"
                )
            
            execution_task += (
                "Follow this plan exactly. If a step is impossible, explain why and request replanning via execution_completion_verifier_agent "
                "instead of drafting a new plan yourself."
            )

            # Extract file expectations from plan for validation
            file_expectations = self._extract_file_expectations_from_plan(plan_text)
            self.logger.info(f"📋 File expectations extracted from plan: {file_expectations}")

            stream = execution_team.run_stream(task=execution_task)

            # Track execution progress incrementally - 1% per agent message
            # Start at 5% and increment for each agent message (5% -> 6% -> 7% -> ...)
            # Progress tracking now handled entirely by progress_handler
            agent_message_count = 0  # Track agent messages for debugging
            last_message = None  # Track the last message for replanning detection
            last_context_update = 0  # Track when we last updated context
            # REMOVED: heartbeat_task - now managed by progress_handler internally

            try:
                async for message in stream:
                    last_message = message  # Keep track of the last message
                    source = getattr(message, "source", None)
                    content = getattr(message, "content", None)

                    # Log every agent message for debugging
                    if source is not None and content is not None:
                        _log_context_to_request_file(task_id, "AGENT_MESSAGE", f"{source}: {content[:1000]}...")
                        self.logger.info(f"🔍 Agent message: {source} - {content[:1000]}...")
                        
                        # Log to agent journey for high-level tracking
                        helpers.log_agent_milestone(work_dir, source, "MESSAGE", content[:100])

                        # Record message in context memory
                        if self.context_memory:
                            self.context_memory.record_message(source, "output", str(content), {
                                "request_id": task_id,
                                "step_number": agent_message_count
                            })
                            self.context_memory.record_agent_action(source, "message", {
                                "content_preview": str(content)[:200]
                            }, None, {
                                "step_number": agent_message_count
                            })
                        
                        # Increment message count
                        agent_message_count += 1
                        
                        # Detect file creation markers ("📁 Ready for upload: path") - check on EVERY message
                        if self.context_memory:
                            import re
                            upload_markers = re.findall(r'📁\s*Ready for upload:\s*(.+)', str(content))
                            for file_path in upload_markers:
                                file_path = file_path.strip()
                                if file_path and os.path.exists(file_path):
                                    try:
                                        # Determine file type from extension
                                        _, ext = os.path.splitext(file_path)
                                        file_type = ext[1:] if ext.startswith('.') else ext
                                        
                                        # Extract content summary based on file type
                                        content_summary = self._extract_file_content_summary(file_path, file_type)
                                        
                                        # Record file creation
                                        self.context_memory.record_file_creation(
                                            file_path,
                                            file_type,
                                            content_summary,
                                            {"file_size": os.path.getsize(file_path) if os.path.exists(file_path) else 0},
                                            source
                                        )
                                        self.logger.info(f"📁 Recorded file creation: {os.path.basename(file_path)} by {source}")
                                    except Exception as e:
                                        self.logger.warning(f"Failed to record file creation for {file_path}: {e}")
                        
                        # Periodic context updates (every 10-15 messages)
                        if self.context_memory and agent_message_count > 0 and (agent_message_count - last_context_update) >= 12:
                            try:
                                # Regenerate focused context summary with latest events
                                updated_context = await self.context_memory.get_focused_agent_context(
                                    "coder_agent",  # General context for all agents
                                    f"Execution in progress (step {agent_message_count})",
                                    max_tokens=3000
                                )
                                # Note: In Swarm, we can't directly inject messages, but the context
                                # will be available in subsequent LLM calls through the conversation history
                                # For now, we log it for debugging
                                _log_context_to_request_file(task_id, "CONTEXT_UPDATE", f"Updated context at message {agent_message_count}: {updated_context[:500]}...")
                                last_context_update = agent_message_count
                            except Exception as e:
                                self.logger.warning(f"Failed to update context summary: {e}")

                        # Check for task completion
                        if "__TASK_COMPLETELY_FINISHED__" in content:
                            _log_context_to_request_file(task_id, "TASK_COMPLETE", f"Task completed by {source}")
                            self.logger.info(f"✅ TASK COMPLETE: Execution phase finished by {source}")

                        # Check for file upload markers - terminate when files are ready
                        if "📁 Ready for upload:" in content:
                            _log_context_to_request_file(task_id, "FILES_READY", f"Files marked for upload by {source}")
                            self.logger.info(f"📁 FILES READY: Execution phase terminating - {source} marked files for upload")
                            # Terminate the swarm since files are ready for upload
                            break

                        # Log potential handoff indicators and track them
                        if "Handing off to" in content or "transfer_to_" in content:
                            _log_context_to_request_file(task_id, "HANDOFF_ATTEMPT", f"{source} attempting handoff: {content}")
                            self.logger.info(f"🔄 HANDOFF ATTEMPT: {source} - {content[:100]}...")
                            
                            # Extract target agent from content
                            import re
                            match = re.search(r'transfer_to_(\w+)', content)
                            if match:
                                target_agent = match.group(1)
                                helpers.log_agent_handoff(work_dir, source, target_agent, "Agent transfer initiated")
                                
                                # Record handoff in context memory
                                if self.context_memory:
                                    self.context_memory.record_handoff(source, target_agent, "Agent transfer initiated", str(content)[:500])

                    # Send progress updates for every agent message
                    if source is not None:
                        # agent_message_count already incremented above
                        
                        # Log internal progress
                        progress_handler.log_internal_progress(task_id, content, source)

                        # Report user progress (sanitized and auto-incremented)
                        actual_percentage = await progress_handler.report_user_progress(
                            task_id, content, percentage=0.0, source=source
                        )
                        
                        if actual_percentage > 0:
                            self.logger.info(f"📊 User progress updated: {actual_percentage:.0%}")
                    # REMOVED: last_progress_time tracking - no longer needed

                    # Log progress
                    if source and content:
                        helpers.append_accomplishment_to_file(work_dir, f"{source}: {str(content)[:1000]}...")
                        helpers.write_current_step_to_file(work_dir, f"{source} processing", source)

                        # VALIDATE FILE CREATION CONTRACTS
                        # If this agent was expected to create files, check if they exist now
                        if source in file_expectations and file_expectations[source]:
                            # Only check if the message indicates completion or handoff
                            # We do NOT check on "Ready for upload" because agents may create files incrementally
                            if "Handing off" in content or "transfer_to" in content:
                                success, missing = self._validate_agent_created_files(
                                    source, 
                                    file_expectations[source],
                                    work_dir
                                )
                                if not success:
                                    # FAIL FAST: Agent claimed to be done/handoff but files are missing
                                    raise WorkflowError(
                                        f"⛔ {source} failed to create required files: {missing}. "
                                        f"Plan expected these files. Check logs/accomplishments.log for errors."
                                    )
            finally:
                # Properly close the async generator to prevent pending tasks
                if hasattr(stream, 'aclose'):
                    await stream.aclose()
                # REMOVED: heartbeat_task cleanup - managed by progress_handler

            # Check if replanning was requested by execution_completion_verifier_agent
            if last_message and getattr(last_message, "source", None) == "execution_completion_verifier_agent":
                content = getattr(last_message, "content", "")
                if "REPLAN:" in str(content):
                    self.logger.info(f"🔄 Replanning requested for task {task_id}: {content}")
                    return f"REPLAN:{content}"  # Special return value to trigger replanning

            # Return work_dir for context memory to use later (upload_results not available yet)
            # Context memory will generate presenter context in _run_upload_and_present_phase
            execution_context = work_dir

            self.logger.info(f"✅ Execution phase completed for task {task_id}")
            return execution_context

        except Exception as e:
            self.logger.error(f"❌ Execution phase failed for {task_id}: {e}")
            raise

    def _extract_file_content_summary(self, file_path: str, file_type: str) -> str:
        """Extract content summary for a file based on its type."""
        try:
            if file_type.lower() == 'csv':
                import pandas as pd
                df = pd.read_csv(file_path, nrows=5)
                return f"CSV with {len(df.columns)} columns: {list(df.columns)}"
            elif file_type.lower() == 'json':
                import json
                with open(file_path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    if isinstance(data, list):
                        return f"JSON array with {len(data)} items"
                    elif isinstance(data, dict):
                        return f"JSON object with keys: {list(data.keys())[:5]}"
                    else:
                        return f"JSON {type(data).__name__}"
            elif file_type.lower() in ['png', 'jpg', 'jpeg']:
                return f"Image file ({file_type})"
            elif file_type.lower() == 'pdf':
                return "PDF document"
            elif file_type.lower() == 'pptx':
                return "PowerPoint presentation"
            elif file_type.lower() == 'xlsx':
                return "Excel spreadsheet"
            else:
                return f"{file_type} file"
        except Exception as e:
            return f"{file_type} file (preview unavailable: {str(e)[:50]})"
    
    def _collect_execution_context(self, work_dir: str) -> str:
        """Collect execution context from accomplishment files for presenter agent."""
        # This method is kept for backward compatibility but is no longer used
        # Context memory handles context generation now
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
                        self.logger.warning("Presenter agent returned no messages")
                        presentation_result = "Presenter agent produced no output."
                        
                except Exception as e:
                    self.logger.error(f"❌ Presenter agent failed: {e}", exc_info=True)
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
                                          presenter_agent, execution_context: str = "", plan_text: str = "") -> str:
        """Run upload and presentation phases using agents."""
        try:
            # Get progress handler
            progress_handler = await self._get_progress_handler()

            # 1. UPLOAD PHASE - Direct upload (simpler and more reliable)
            await progress_handler.handle_progress_update(
                task_id, 0.94, "📤 Uploading deliverables..."
            )

            self.logger.info(f"📤 Directly uploading files for task {task_id} from {work_dir}")

            # Import the unified upload function
            from tools.azure_blob_tools import upload_files

            # Get list of files in work directory
            import os
            if os.path.exists(work_dir):
                all_files = []
                for root, dirs, files in os.walk(work_dir):
                    # CRITICAL: Skip reference_data directories to prevent uploading reference files as deliverables
                    # This prevents bugs like uploading currency CSV when user wants Pokemon PPTX
                    if 'reference_data' in root:
                        continue
                    
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
                    # FAIL FAST: No deliverable files found - this is a workflow coordination failure
                    raise WorkflowError(
                        f"⛔ No deliverable files found in {work_dir}. "
                        f"This means upstream agents (aj_sql_agent, web_search_agent, coder_agent) "
                        f"failed to create their expected outputs. "
                        f"Check logs/accomplishments.log and logs/agent_journey.log for agent errors. "
                        f"Common causes: SQL query failures, web search timeouts, missing input data."
                    )
            else:
                raise WorkflowError(f"Work directory does not exist: {work_dir}")

            self.logger.info(f"📤 Upload response length: {len(upload_response_text)}")

            # 2. PRESENTATION PHASE - Use Presenter Agent
            present_msg = "✨ Finalizing your results..."
            self.recent_progress_messages.append(present_msg)
            await progress_handler.handle_progress_update(
                task_id, 0.95, present_msg
            )

            # Use context memory to generate comprehensive presenter context
            try:
                upload_data = json.loads(upload_response_text)
            except:
                upload_data = {"uploads": []}
            
            # Generate presenter context using context memory
            if self.context_memory:
                presenter_context = await self.context_memory.get_presenter_context(
                    task, upload_data, plan_text
                )
                
                # Add prominent structured data mapping section - CRITICAL for preventing value reconstruction
                structured_data_section = ""
                try:
                    if "uploads" in upload_data and upload_data["uploads"]:
                        structured_data_section = "\n\n" + "="*80 + "\n"
                        structured_data_section += "🚨🚨🚨 MANDATORY STRUCTURED DATA MAPPING - USE EXACT VALUES 🚨🚨🚨\n"
                        structured_data_section += "="*80 + "\n"
                        structured_data_section += "**CRITICAL PRINCIPLE**: Structured data provides exact values - use them EXACTLY as provided.\n"
                        structured_data_section += "**FORBIDDEN**: DO NOT reconstruct values from related fields - it causes authentication failures!\n"
                        structured_data_section += "**REQUIRED**: Copy the EXACT field values below - do NOT modify, strip, or reconstruct.\n\n"
                        
                        for upload in upload_data["uploads"]:
                            fname = upload.get("local_filename", "")
                            download_url = upload.get("download_url", "")
                            
                            if download_url:
                                structured_data_section += f"📁 File: {fname}\n"
                                structured_data_section += f"   ✅ EXACT VALUE TO USE (copy this entire value):\n"
                                structured_data_section += f"   {download_url}\n"
                                structured_data_section += f"   ⚠️  Use this EXACT value - do NOT reconstruct from filename or other fields!\n\n"
                        
                        structured_data_section += "="*80 + "\n"
                        structured_data_section += "**MANDATORY VALIDATION**: Before outputting content, verify every value matches an EXACT value from above.\n"
                        structured_data_section += "="*80 + "\n\n"
                except Exception as e:
                    self.logger.warning(f"Failed to generate structured data mapping section: {e}")
                
                presenter_context += structured_data_section
                
                # Add critical instructions with structured data validation emphasis
                presenter_context += """

**🚨🚨🚨 CRITICAL INSTRUCTIONS - READ CAREFULLY 🚨🚨🚨**:

**MANDATORY STRUCTURED DATA VALIDATION (DO THIS FIRST)**:
1. **FIND STRUCTURED DATA MAPPING**: Look for the "MANDATORY STRUCTURED DATA MAPPING" section above - it shows exact values to use
2. **EXTRACT EXACT VALUES**: Copy the EXACT field values from the mapping - do NOT reconstruct from related fields
3. **VERIFY COMPLETENESS**: Ensure values include all required components (not truncated or partial)
4. **VALIDATE BEFORE OUTPUT**: Before outputting final content, verify every value matches an EXACT value from the mapping

**OTHER CRITICAL INSTRUCTIONS**:
1. **Data Source Citation**: If execution context mentions SQL/database/AlJazeera/aj_sql_agent, you MUST start with "📊 Data Source: Al Jazeera Internal Database (via SQL query execution)"

2. **Use ALL Available Context**: Review:
   - The execution context shows what was accomplished
   - File summary shows ALL files that were created
   - CSV previews show the actual data
   
3. **Display Data Properly**: 
   - For CSV files, show the FULL DATA PREVIEW table provided above (not just 2-3 sample rows)
   - Mention ALL CSV files that were created, not just one
   - Use the column information to understand what data is in each file

4. **Be Complete**: 
   - If multiple deliverables were requested (e.g., "chart and CSV"), ensure you mention ALL of them
   - Check file summary for all created files (CSVs, charts, etc.)
   - Don't assume - use the context to verify what actually exists

5. **Provide Insights**: Based on the data previews and task, give meaningful analysis

6. **Include Download Links**: Use the EXACT values from the structured data mapping above - do NOT reconstruct values from related fields

You MUST show the data preview table and data source citation.
"""
            else:
                # Fallback to old method if context_memory not available
                self.logger.warning("ContextMemory not available, using fallback context generation")
                presenter_context = f"""
Task: {task}
Work Directory: {work_dir}
Upload Results: {upload_response_text}
Execution Context: {execution_context}
"""

            # Run presenter agent - let it fail cleanly if needed
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


        except WorkflowError as e:
            # Workflow coordination failures - send clear, actionable error to user
            self.logger.error(f"⛔ Workflow coordination failed for {task_id}: {e}")
            
            try:
                # Send user-friendly version of the error
                user_msg = self._format_workflow_error_for_user(str(e))
                await progress_handler.handle_progress_update(
                    task_id, 1.0, "❌ Task failed",
                    data=user_msg
                )
            except Exception as send_err:
                self.logger.error(f"Failed to send workflow error message: {send_err}")
            
            return f"Workflow failed: {str(e)}"

        except Exception as e:
            self.logger.error(f"❌ Upload/presentation phase failed for {task_id}: {e}")
            
            # CRITICAL: Always send a final message to the user so they aren't stuck
            try:
                error_msg = f"Task completed with some issues: {str(e)}"
                await progress_handler.handle_progress_update(
                    task_id, 1.0, "⚠️ Task completed with issues",
                    data=error_msg
                )
            except Exception as send_err:
                self.logger.error(f"Failed to send final error message: {send_err}")
                
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
    """Log context information to per-request logs/context.log."""
    try:
        import os
        from datetime import datetime

        work_dir = f"/tmp/coding/req_{task_id}"
        logs_dir = os.path.join(work_dir, "logs")
        os.makedirs(logs_dir, exist_ok=True)

        context_log_path = os.path.join(logs_dir, "context.log")

        timestamp = datetime.now().isoformat()
        log_entry = f"[{timestamp}] {context_type}: {context_data}\n"

        with open(context_log_path, "a", encoding="utf-8") as f:
            f.write(log_entry)

    except Exception as e:
        logger.warning(f"Failed to log context: {e}")