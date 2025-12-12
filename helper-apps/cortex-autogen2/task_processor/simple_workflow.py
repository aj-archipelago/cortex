"""
Simplified Workflow Implementation

Uses SelectorGroupChat for intelligent agent routing - no need for picker agent or graph structure.
SelectorGroupChat automatically selects the right agent based on descriptions.

Minimal code - all processing logic moved to services.
"""

import logging
import os
import time
import asyncio
from typing import List, Optional, Dict
from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.teams import SelectorGroupChat
from .score_termination import create_score_based_termination

logger = logging.getLogger(__name__)


class SimplifiedWorkflow:
    """
    Simplified workflow using SelectorGroupChat for intelligent agent routing.
    SelectorGroupChat automatically picks the right agent based on descriptions.
    """

    def __init__(self, model_client):
        self.model_client = model_client
        self._last_report_time: Dict[str, float] = {}  # Track last report time per task
        self._task_progress: Dict[str, float] = {}  # Track current progress per task
        self.last_presenter_msg = None  # Track last presenter_agent TextMessage

    async def run_workflow(
        self,
        task: str,
        planner_agent: AssistantAgent,
        execution_agents: List[AssistantAgent],
        presenter_agent: AssistantAgent,
        execution_completion_verifier_agent: AssistantAgent,
        task_id: Optional[str] = None,
        work_dir: Optional[str] = None,
        progress_handler: Optional[object] = None,
        context_memory: Optional[object] = None,
        model_client_for_processing: Optional[object] = None
    ) -> str:
        """
        Run simplified workflow using SelectorGroupChat:
        1. SelectorGroupChat automatically picks planner_agent first (description says "Select FIRST")
        2. Intelligently routes between all agents based on their descriptions
        3. Score-based termination when presentation quality > 90
        """

        # All agents together - SelectorGroupChat handles routing intelligently
        all_agents = [
            planner_agent,
            *execution_agents,
            presenter_agent,
            execution_completion_verifier_agent
        ]

        # Initialize messages.jsonl file if work_dir is provided
        messages_file_path = None
        if work_dir and task_id:
            logs_dir = os.path.join(work_dir, "logs")
            os.makedirs(logs_dir, exist_ok=True)
            messages_file_path = os.path.join(logs_dir, "messages.jsonl")
            
            # Log task start to worklog (full description, no truncation)
            if context_memory:
                context_memory.log_worklog(
                    "system", "task_start", f"Task started: {task}", status="in_progress",
                    metadata={"task_id": task_id}
                )

        all_messages = []  # Mutable list for tracking messages
        score_based_termination = create_score_based_termination(all_messages, threshold=90)

        # Create SelectorGroupChat team with score-based termination
        team = SelectorGroupChat(
            participants=all_agents,
            model_client=self.model_client,
            termination_condition=score_based_termination,
            max_turns=500  # Allow enough turns for complex workflows
        )

        # Send initial progress update (auto-starts heartbeat and sets 5%)
        if progress_handler and task_id:
            try:
                asyncio.create_task(progress_handler.report_user_progress(
                    task_id, "🚀 Starting your task...", percentage=0.05, source="system"
                ))
                self._task_progress[task_id] = 0.05
            except Exception as e:
                logger.debug(f"Failed to send initial progress update: {e}")

        # Run the workflow with streaming to log messages as they come in
        # planner_agent description says "Select FIRST" so it will be picked automatically
        stream = team.run_stream(task=task)

        async for message in stream:
            all_messages.append(message)

            # Extract message metadata
            message_source = getattr(message, "source", "unknown")
            message_type = type(message).__name__
            message_content = getattr(message, "content", "")
            content_str = str(message_content) if message_content else ""

            # Update last presenter message tracking
            if message_source == 'presenter_agent' and message_type == 'TextMessage':
                self.last_presenter_msg = message

            logger.debug(f"🔍 From agent {message_source}, Message: {message}")
            
            # LLM-powered early termination detection
            if model_client_for_processing:
                from services.termination_detector import should_terminate_early
                should_terminate, score = await should_terminate_early(
                    message_source, message_type, content_str, model_client_for_processing
                )
                if should_terminate:
                    logger.info(f"✅ Early stop: verifier score {score} > 90. Ending workflow stream.")
                    break
            
            # Process message through service (LLM-powered worklog/learnings/file detection)
            from services.message_processor import process_message
            await process_message(
                message, context_memory, model_client_for_processing,
                task_id, work_dir, messages_file_path
            )
            
            # Progress tracking
            if progress_handler and task_id:
                current_progress = self._task_progress.get(task_id, 0.05)
                next_progress = min(current_progress + 0.01, 0.94)
                self._task_progress[task_id] = next_progress

                # Send progress update every 30 seconds
                try:
                    current_time = time.time()
                    last_report_time = self._last_report_time.get(task_id, 0)
                    if current_time - last_report_time >= 30.0:
                        asyncio.create_task(progress_handler.report_user_progress(
                            task_id, content_str, percentage=None, source=message_source
                        ))
                        self._last_report_time[task_id] = current_time
                except Exception as e:
                    logger.debug(f"Failed to send progress update: {e}")

        result = all_messages[-1] if len(all_messages) > 0 else None

        # Get final result from presenter_agent
        final_result = self.last_presenter_msg.content if self.last_presenter_msg else None

        # Send 95% progress - task execution complete, processing final results
        if progress_handler and task_id:
            try:
                result_preview = final_result[:150] + "..." if final_result and len(final_result) > 150 else (final_result if final_result else "Processing results")
                # Fire-and-forget - don't block final result return
                asyncio.create_task(progress_handler.report_user_progress(
                    task_id, f"✨ Task execution complete - finalizing results: {result_preview}",
                    percentage=0.95, source="system"
                ))
            except Exception as e:
                logger.debug(f"Failed to send 95% progress update: {e}")

        # Print agent flow like [planner_agent, presenter_agent, execution_completion_verifier_agent]
        agent_flow = [msg.source for msg in all_messages if hasattr(msg, 'source')]
        logger.info(f"🤝 AGENT FLOW: {agent_flow}")

        
        stop_reason = getattr(result, "stop_reason", None) if result else None
        logger.info(f"🤝 SIMPLE WORKFLOW COMPLETED: {len(all_messages)} messages processed, stop_reason: {stop_reason or 'Workflow completed'}, result: {result}")
        
        # CRITICAL: Send final result as progress update with data field (100% progress)
        # This ensures test runner can capture the final result
        if progress_handler and task_id and final_result:
            try:
                await progress_handler.handle_progress_update(
                    task_id, 1.0, "🎉 Your task is complete!", data=final_result
                )
                logger.info(f"✅ Final result sent as progress update (100%) with data field")
            except Exception as e:
                logger.error(f"❌ Failed to send final result as progress update: {e}")
        
        # Process learnings via service (LLM-powered)
        if context_memory and task_id and final_result:
            from services.learning_processor import process_task_completion_learnings
            await process_task_completion_learnings(
                context_memory, task_id, task, final_result, model_client_for_processing
            )
        
        # Log task completion to worklog
        if context_memory and task_id:
            try:
                context_memory.log_worklog(
                    "system", "task_completion",
                    f"Task completed successfully with {len(all_messages)} messages processed",
                    status="completed",
                    metadata={"task_id": task_id, "message_count": len(all_messages), "agent_flow": agent_flow}
                )
            except Exception as e:
                logger.warning(f"Failed to log task completion: {e}")
        
        # Return last presenter_agent TextMessage content
        return final_result
