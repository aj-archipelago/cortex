"""
Planner phase handler for task execution planning.
"""
import logging

from agents.util.workflow_utils import run_agent_with_timeout

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




