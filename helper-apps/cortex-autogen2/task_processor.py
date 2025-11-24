"""
Task Processor - Backward compatibility wrapper.

This file maintains backward compatibility by re-exporting the main functions
from the refactored task_processor package.
"""

# Re-export everything from the refactored package
from task_processor import (
    TaskProcessor,
    get_task_processor,
    process_queue_message,
    # Also export utilities for backward compatibility
    _stringify_content,
    ProgressHandler,
)

__all__ = [
    'TaskProcessor',
    'get_task_processor',
    'process_queue_message',
    '_stringify_content',
    'ProgressHandler',
]