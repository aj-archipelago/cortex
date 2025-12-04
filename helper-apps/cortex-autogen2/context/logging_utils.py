"""
Logging utilities for consistent phase logging across the system.
"""

# Helper functions for common logging patterns
async def log_phase_start(context_memory, event_type: str, agent_name: str, details: dict, task_id: str, phase: str):
    """Log the start of a phase with consistent formatting."""
    if context_memory:
        context_memory.record_comprehensive_log(
            event_type=event_type,
            details=details,
            agent_name=agent_name,
            metadata={"task_id": task_id, "phase": phase}
        )

async def log_phase_complete(context_memory, event_type: str, agent_name: str, details: dict, task_id: str, phase: str):
    """Log the completion of a phase with consistent formatting."""
    if context_memory:
        context_memory.record_comprehensive_log(
            event_type=event_type,
            details=details,
            agent_name=agent_name,
            metadata={"task_id": task_id, "phase": phase}
        )
