"""
Planner phase handler for task execution planning.
"""
import logging

from dynamic_agent_loader import helpers
import asyncio
from autogen_core import CancellationToken

# run_agent_with_timeout may not exist in all helpers versions - provide fallback
try:
    run_agent_with_timeout = helpers.run_agent_with_timeout
except AttributeError:
    async def run_agent_with_timeout(agent, task: str, timeout_seconds: int, logger):
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

logger = logging.getLogger(__name__)


class PlannerPhase:
    """Handles the planning phase of task execution."""

    def __init__(self, logger=None):
        self.logger = logger or logging.getLogger(__name__)

    async def run_planner_phase(self, task_id: str, task: str, work_dir: str, planner_agent) -> str:
        """Run the planner agent separately to create a plan."""
        print(f"🔥 DEBUG: _run_planner_phase called for task {task_id}")
        self.logger.info(f"📋 Starting planner phase for task {task_id}")

        planner_task = f"Create a detailed execution plan for this task. End with 'END_PLAN' when complete:\n\n{task}"

        try:
            # Run planner agent directly
            result = await run_agent_with_timeout(planner_agent, planner_task, 120, self.logger)
            plan_text = ""
            if hasattr(result, 'messages') and result.messages:
                for message in result.messages:
                    if hasattr(message, 'content') and message.content:
                        plan_text += str(message.content) + "\n"

            self.logger.info(f"📋 Planner phase completed, plan length: {len(plan_text)}")
            return plan_text.strip()
        except Exception as e:
            self.logger.error(f"📋 Planner phase failed: {e}")
            return f"Basic plan: Execute the requested task step by step."




