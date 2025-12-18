import json
import logging
import os
import traceback
import asyncio
from typing import Optional, Dict, Any, List

from autogen_core import CancellationToken


from services.azure_queue import get_queue_service
from services.redis_publisher import get_redis_publisher
from dynamic_agent_loader import agent_factory, helpers, get_agents

from .progress_handler import ProgressHandler
from .message_utils import _stringify_content
from .message_processor import MessageProcessor
from .model_config import ModelConfig
from .phases.group_phase import GroupPhase
from .phases.delivery_phase import DeliveryPhase
from context.context_memory import ContextMemory
from context.logging_utils import log_phase_start, log_phase_complete

# Custom exception for workflow coordination failures
class WorkflowError(Exception):
    """Raised when agent workflow coordination fails."""
    pass

logger = logging.getLogger(__name__)


async def _run_agent_with_timeout(agent, task: str, timeout_seconds: int, logger) -> Any:
    """Run an agent with timeout and consistent error handling."""
    try:
        result = await asyncio.wait_for(
            agent.run(task=task, cancellation_token=CancellationToken()),
            timeout=timeout_seconds
        )
        return result
    except asyncio.TimeoutError:
        logger.error(f"Agent {agent.name if hasattr(agent, 'name') else 'unknown'} timed out after {timeout_seconds}s")
        raise RuntimeError(f"Agent timed out after {timeout_seconds}s")

def _extract_json_from_response(response_text: str) -> dict:
    """Extract JSON from agent response text, with fallback to empty dict."""
    from util.json_extractor import extract_json_from_llm_response
    
    result = extract_json_from_llm_response(response_text, expected_type=dict, log_errors=False)
    if result:
        return result
    # Fallback: return message wrapper if not JSON
    return {"message": response_text}



class TaskProcessor:
    """
    Main processor for handling AI agent tasks with progress tracking and result publishing.
    """

    def __init__(self, logger=None, debug_progress_msgs=False):
        """Initialize the task processor with required services."""
        self.queue_service = get_queue_service()
        self.redis_publisher = None
        self.logger = logger or logging.getLogger(__name__)
        self.debug_progress_msgs = debug_progress_msgs
        self.gpt41_model_client = ModelConfig.create_model_client("gpt-4.1")
        self.o3_model_client = ModelConfig.create_model_client("o3")
        self.progress_handler = None
        self.context_memory = None
        self.message_processor = None
        self.group_phase = None
        self.upload_phase = None

    async def initialize(self):
        """Initialize async services."""
        # Pre-initialize redis publisher and progress handler
        await self._get_redis_publisher()
        await self._get_progress_handler()
        self.logger.info("✅ TaskProcessor initialized successfully")

    async def close(self):
        """Clean up async services."""
        if self.redis_publisher:
            await self.redis_publisher.close()
        self.logger.info("🔌 TaskProcessor connections closed")

    async def _get_redis_publisher(self):
        if self.redis_publisher is None:
            self.redis_publisher = await get_redis_publisher()
        return self.redis_publisher

    async def _get_progress_handler(self):
        if self.progress_handler is None:
            redis_pub = await self._get_redis_publisher()
            self.progress_handler = ProgressHandler(redis_pub, 
             self.gpt41_model_client
            #self.gpt5_mini_model_client
            )
        return self.progress_handler

    async def process_task(self, task_id: str, task_content: str, runner_info: dict = None) -> str:
        try:
            print(f"🔥 DEBUG: process_task called for {task_id}")
            task = self._extract_task_content(task_content)
            self.logger.info(f"🎯 Processing task {task_id}: {task[:100]}...")

            request_work_dir = f"/tmp/coding/req_{task_id}"
            os.makedirs(request_work_dir, exist_ok=True)

            progress_handler = await self._get_progress_handler()
            
            # Initialize ContextMemory for this request
            self.context_memory = ContextMemory(request_work_dir, self.gpt41_model_client, task_id)
            self.message_processor = MessageProcessor(self.context_memory, self.gpt41_model_client, progress_handler)
            self.group_phase = GroupPhase(self.context_memory, self.message_processor, self.gpt41_model_client, self.logger)
            self.delivery_phase = DeliveryPhase(self.context_memory, progress_handler, self.logger)
            
            # Log task start to worklog
            self.context_memory.log_worklog(
                "system", "task_start", f"Task started: {task}", status="in_progress",
                metadata={"task_id": task_id}
            )
            
            # Initialize cognitive journey tracking
            from context.cognitive_journey_mapper import get_cognitive_journey_mapper
            journey_mapper = get_cognitive_journey_mapper()
            journey_mapper.start_journey(task_id, ["planner_agent", "coder_agent", "web_search_agent", "presenter_agent"])
            progress_handler.set_context_memory(self.context_memory)
            # Extract key task context for brain-aware progress messages
            task_preview = task[:200] + "..." if len(task) > 200 else task
            await progress_handler.start_heartbeat(task_id, "🚀 Starting your task...", task_context=task_preview)

            context_files = helpers.build_dynamic_context_from_files(request_work_dir, task)
            task_with_context = f"{task}\n\nContext from previous work:\n{context_files}"

            # Retrieve learnings from Azure Cognitive Search
            from services.learning_service import get_learnings_for_task
            learnings = await get_learnings_for_task(task, task_id, self.gpt41_model_client, self.context_memory)

            planner_agent, execution_agents, presenter_agent = await get_agents(
                self.gpt41_model_client,
                self.o3_model_client,
                self.gpt41_model_client,
                request_work_dir=request_work_dir,
                request_id=task_id,
                task_content=task,
                planner_learnings=learnings,
            )

            result = await self._run_agent_workflow(
                task_id, task_with_context, request_work_dir,
                planner_agent, execution_agents, presenter_agent,
                self.context_memory
            )

            return result

        except Exception as e:
            traceback.print_exc()
            try:
                progress_handler = await self._get_progress_handler()
                await progress_handler.stop_heartbeat(task_id)
                error_msg = str(e)[:100].replace('{', '{{').replace('}', '}}')
                await progress_handler.handle_progress_update(
                    task_id, 1.0, f"❌ Task failed: {error_msg}..."
                )
            except Exception:
                pass
            self.logger.error(f"❌ Task processing failed for {task_id}: {e}", exc_info=True)
            return f"Task failed: {str(e)}"

    def _extract_task_content(self, task_content: str) -> str:
        try:
            parsed = json.loads(task_content)
            if isinstance(parsed, dict):
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
        context_memory=None
    ) -> str:
        progress_handler = await self._get_progress_handler()
        await progress_handler.handle_progress_update(task_id, 0.05, "🚀 Starting your task...")

        # Group phase (SelectorGroupChat handles everything: planning + execution)
        # Wrap in timeout to ensure presenter phase always executes
        # Use 9000s default (tests intentionally have low global timeout, but group phase should complete before that)
        self.logger.info("🤝 Starting group phase...")
        group_phase_timeout = int(os.getenv('GROUP_PHASE_TIMEOUT_SECONDS', '9000'))
        try:
            execution_context = await asyncio.wait_for(
                self.group_phase.run_group_phase(task_id, task, work_dir, planner_agent, execution_agents),
                timeout=group_phase_timeout
            )
        except asyncio.TimeoutError:
            self.logger.warning(f"⏱️ Group phase timed out after {group_phase_timeout} seconds. Proceeding to presenter phase.")
            execution_context = work_dir  # Use work_dir as fallback context
        except Exception as e:
            self.logger.error(f"❌ Group phase failed with error: {e}. Proceeding to presenter phase.")
            execution_context = work_dir  # Use work_dir as fallback context

        # Present phase - presenter_agent handles both upload and presentation
        # Always execute presenter phase regardless of group phase outcome
        result = await self.delivery_phase.run_present_phase(
            task_id, task, work_dir, presenter_agent, execution_context, ""
        )

        # Complete cognitive journey tracking
        from context.cognitive_journey_mapper import get_cognitive_journey_mapper
        journey_mapper = get_cognitive_journey_mapper()
        journey_analytics = journey_mapper.get_journey_analytics(task_id)
        journey_mapper.complete_journey(task_id, "completed" if "ERROR" not in result else "failed")

        # Extract and save learnings if successful (skip for one-shot simple tasks)
        from services.learning_service import extract_and_save_learnings, _extract_success_score_from_result
        success_score = _extract_success_score_from_result(result)
        
        # Detect if this was a one-shot simple task (skip learnings for these)
        is_one_shot = False
        if context_memory and hasattr(context_memory, 'event_recorder'):
            events = context_memory.event_recorder.events
            # One-shot: few events, no errors, quick completion
            error_count = len([e for e in events if e.get("event_type") == "error"])
            file_count = len([e for e in events if e.get("event_type") == "file_creation"])
            # Count agent handoffs/decisions to detect complexity
            handoff_count = len([e for e in events if e.get("event_type") == "handoff"])
            decision_count = len([e for e in events if e.get("event_type") == "decision"])
            # Simple task: <= 3 files, no errors, few handoffs/decisions, success score high
            # More lenient: score >= 90 (not 95) and allow up to 1 handoff/decision
            if error_count == 0 and file_count <= 3 and (handoff_count + decision_count) <= 1 and success_score >= 90:
                is_one_shot = True
                self.logger.info(f"🎯 One-shot simple task detected (files: {file_count}, errors: {error_count}, handoffs: {handoff_count}, decisions: {decision_count}, score: {success_score}) - skipping learnings")
        
        if success_score >= 90 and context_memory and not is_one_shot:
            await extract_and_save_learnings(
                task_id, task, context_memory, journey_analytics, success_score, self.gpt41_model_client
            )
        elif is_one_shot:
            # Still log that it was a one-shot success (for tracking)
            if context_memory:
                context_memory.log_learning(
                    learning_type="one_shot_success",
                    content=f"One-shot simple task completed successfully (score: {success_score})",
                    source="system",
                    success_score=success_score,
                    metadata={"task": task, "files_created": file_count, "errors": error_count}
                )

        return result




