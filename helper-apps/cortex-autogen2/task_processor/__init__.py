"""
Task Processor Package

Refactored from the monolithic task_processor.py into smaller, focused modules.
"""

from .message_utils import (
    _stringify_content,
)


from .progress_handler import ProgressHandler

# Import main classes and functions from the main module
from .agent_workflow_processor import TaskProcessor, get_task_processor, process_queue_message

__all__ = [
    # Message utilities
    '_stringify_content',

    # Model client

    # Progress handling
    'ProgressHandler',

    # Main classes and functions
    'TaskProcessor',
    'get_task_processor',
    'process_queue_message',
]
