"""
Simplified Workflow Implementation

Uses SelectorGroupChat for intelligent agent routing - no need for picker agent or graph structure.
SelectorGroupChat automatically selects the right agent based on descriptions.
"""

import json
import logging
import os
import time
import asyncio
from datetime import datetime
from typing import List, Optional, Dict
from autogen_agentchat.agents import AssistantAgent
from autogen_agentchat.teams import SelectorGroupChat
from autogen_agentchat.base._task import TaskResult
from autogen_agentchat.messages import StopMessage
from .score_termination import create_score_based_termination
from autogen_core.model_context import BufferedChatCompletionContext

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
        progress_handler: Optional[object] = None
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

        all_messages = []
        
        # Track message history for progress updates (up to 10k chars)
        message_history = []
        message_history_chars = 0
        MAX_HISTORY_CHARS = 10000

        # Initialize messages.jsonl file if work_dir is provided
        messages_file_path = None
        if work_dir and task_id:
            logs_dir = os.path.join(work_dir, "logs")
            os.makedirs(logs_dir, exist_ok=True)
            messages_file_path = os.path.join(logs_dir, "messages.jsonl")

        score_based_termination = create_score_based_termination(all_messages,threshold=90)

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

            # Extract message content and source
            message_content = getattr(message, "content", "")
            message_source = getattr(message, "source", "unknown")
            message_type = type(message).__name__

            # Update last presenter message tracking
            if message_source == 'presenter_agent' and message_type == 'TextMessage':
                self.last_presenter_msg = message

            logger.debug(f"🔍 From agent {message_source}, Message: {message}")
            
            # Convert content to string if needed
            if message_content:
                content_str = str(message_content)
            else:
                content_str = ""
            
            # Save to logs/messages.jsonl under the req_XXX request id folder
            if messages_file_path:
                try:
                    message_entry = {
                        "timestamp": datetime.now().isoformat(),
                        "agent_name": message_source,
                        "message_type": message_type,
                        "content": content_str,
                        "metadata": {
                            "request_id": task_id,
                            "message_index": len(all_messages) - 1
                        }
                    }
                    with open(messages_file_path, 'a', encoding='utf-8') as f:
                        f.write(json.dumps(message_entry, ensure_ascii=False) + '\n')
                except Exception as e:
                    logger.warning(f"Failed to save message to JSONL: {e}")
            
            # Build message history for progress updates (up to 10k chars)
            if content_str:
                # Add new message to history
                message_history.append(f"{message_source}: {content_str}")
                message_history_chars += len(content_str) + len(message_source) + 2  # +2 for ": "
                
                # Trim history if it exceeds MAX_HISTORY_CHARS
                while message_history_chars > MAX_HISTORY_CHARS and len(message_history) > 1:
                    removed = message_history.pop(0)
                    message_history_chars -= len(removed)
            
            # Increment progress for every message, send LLM update every 15 seconds
            if progress_handler and task_id:
                # Always increment progress locally for every message
                current_progress = self._task_progress.get(task_id, 0.05)
                next_progress = min(current_progress + 0.01, 0.94)
                self._task_progress[task_id] = next_progress

                # Send LLM-summarized progress update every 15 seconds
                try:
                    current_time = time.time()
                    last_report_time = self._last_report_time.get(task_id, 0)

                    if current_time - last_report_time >= 30.0:
                        # Fire-and-forget - send with percentage=None to trigger auto-increment (+1%)
                        asyncio.create_task(progress_handler.report_user_progress(
                            task_id, content_str, percentage=None, source=message_source
                        ))
                        self._last_report_time[task_id] = current_time
                except Exception as e:
                    logger.debug(f"Failed to send progress update: {e}")

        result = all_messages[-1] if len(all_messages) > 0 else None

        # Send 95% progress - task execution complete, processing final results
        if progress_handler and task_id:
            try:
                result_preview = self.last_presenter_msg.content[:150] + "..." if self.last_presenter_msg and len(self.last_presenter_msg.content) > 150 else (self.last_presenter_msg.content if self.last_presenter_msg else "Processing results")
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

        
        logger.info(f"🤝 SIMPLE WORKFLOW COMPLETED: {len(all_messages)} messages processed, stop_reason: {result.stop_reason or 'Workflow completed'}, result: {result}")
        
        # Return last presenter_agent TextMessage content
        return self.last_presenter_msg.content if self.last_presenter_msg else None
