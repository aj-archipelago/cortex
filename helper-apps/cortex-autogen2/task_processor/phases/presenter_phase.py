"""
Presenter phase handler for final result presentation.
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
from context.logging_utils import log_phase_start, log_phase_complete

logger = logging.getLogger(__name__)


class PresenterPhase:
    """Handles the presenter agent execution and result formatting."""

    def __init__(self, context_memory, logger=None):
        self.context_memory = context_memory
        self.logger = logger or logging.getLogger(__name__)

    async def run_presenter_agent(self, presenter_agent, context: str, work_dir: str, task_id: str) -> str:
        # Log presenter execution start
        if self.context_memory:
            await log_phase_start(
                self.context_memory, "presenter_start", "presenter_agent",
                {
                    "context_length": len(context),
                    "work_dir": work_dir,
                    "context_preview": context[:200]
                },
                task_id, "presentation"
            )

        try:
            logger.info(f"🎭 STARTING PRESENTER AGENT with context length: {len(context)}")
            task_result = await run_agent_with_timeout(presenter_agent, context, 180, logger)
            logger.info(f"🎭 PRESENTER AGENT COMPLETED with {len(task_result.messages) if task_result.messages else 0} messages")

            presentation_result = str(task_result.messages[-1].content) if task_result.messages else "Presenter agent produced no output."

            # Clean up any remaining task completion markers from presenter response
            if "__TASK_COMPLETELY_FINISHED__" in presentation_result:
                presentation_result = presentation_result.replace("__TASK_COMPLETELY_FINISHED__", "").strip()

            # Log presenter completion
            if self.context_memory:
                await log_phase_complete(
                    self.context_memory, "presenter_complete", "presenter_agent",
                    {
                        "result_length": len(presentation_result),
                        "has_task_finished_marker": "__TASK_COMPLETELY_FINISHED__" in presentation_result,
                        "message_count": len(task_result.messages) if task_result.messages else 0
                    },
                    task_id, "presentation"
                )

            return presentation_result
        except Exception as e:
            self.logger.error(f"❌ Presenter processing failed: {e}")
            raise




