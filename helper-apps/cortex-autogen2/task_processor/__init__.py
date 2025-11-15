"""
Task Processor Package

Refactored from the monolithic task_processor.py into smaller, focused modules.
"""

from .message_utils import (
    _message_to_dict,
    _stringify_content,
    _coerce_message_object,
    _wrap_json_if_needed,
    _normalize_single_message
)

from .model_client import RoleFixingModelClientWrapper

from .progress_handler import ProgressHandler

# Import main classes and functions from the main module
from .agent_workflow_processor import TaskProcessor, get_task_processor, process_queue_message

__all__ = [
    # Message utilities
    '_message_to_dict',
    '_stringify_content',
    '_coerce_message_object',
    '_wrap_json_if_needed',
    '_normalize_single_message',

    # Model client
    'RoleFixingModelClientWrapper',

    # Progress handling
    'ProgressHandler',

    # Main classes and functions
    'TaskProcessor',
    'get_task_processor',
    'process_queue_message',
]
