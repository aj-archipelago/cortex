"""
Execution phase handler for unified agent execution.
"""
import os
import logging

from autogen_agentchat.teams import SelectorGroupChat
from autogen_agentchat.conditions import TextMentionTermination

from context.logging_utils import log_phase_start, log_phase_complete

logger = logging.getLogger(__name__)


class GroupPhase:
    """Handles the unified group phase with SelectorGroupChat (planning + execution)."""

    def __init__(self, context_memory, message_processor, gpt41_model_client, logger=None):
        self.context_memory = context_memory
        self.message_processor = message_processor
        self.gpt41_model_client = gpt41_model_client
        self.logger = logger or logging.getLogger(__name__)

    async def run_group_phase(self, task_id: str, task: str, work_dir: str,
                                         planner_agent, execution_agents, plan_text: str = "") -> str:
        print(f"🔥 DEBUG: _run_unified_execution_phase called for task {task_id}")
        self.logger.info(f"🔥 DEBUG: _run_unified_execution_phase called for task {task_id}")

        execution_team = SelectorGroupChat(
            participants=[planner_agent] + execution_agents,  # Planner first, then execution agents
            model_client=self.gpt41_model_client,
            termination_condition=TextMentionTermination("EXECUTION_PHASE_COMPLETE"),
            max_turns=int(os.getenv('SELECTOR_MAX_TURNS', '250')),
            allow_repeated_speaker=True
        )

        execution_task = f"{task}\n\nEXECUTION PLAN:\n{plan_text}\n\n"

        # Run the unified group phase (SelectorGroupChat handles planning + execution)
        self.logger.info(f"🤝 STARTING GROUP PHASE with task: {execution_task[:100]}...")
        result = await execution_team.run(task=execution_task)
        self.logger.info(f"🤝 GROUP PHASE COMPLETED: result type = {type(result)}, has messages = {hasattr(result, 'messages')}")
        if hasattr(result, 'messages'):
            self.logger.info(f"🤝 MESSAGES COUNT: {len(result.messages) if result.messages else 0}")

        # Process all messages from the result
        self.logger.info(f"🤝 ABOUT TO CALL MESSAGE PROCESSOR: result.messages exists = {hasattr(result, 'messages')}")
        try:
            self.logger.info(f"🤝 CALLING MESSAGE PROCESSOR: About to process {len(result.messages) if hasattr(result, 'messages') else 0} messages")
            await self.message_processor.process_agent_messages(result, task_id)
            self.logger.info(f"🤝 MESSAGE PROCESSOR COMPLETED")
        except Exception as e:
            self.logger.error(f"🤝 MESSAGE PROCESSOR FAILED: {e}")
            import traceback
            self.logger.error(f"🤝 TRACEBACK: {traceback.format_exc()}")

        return work_dir
