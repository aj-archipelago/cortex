"""
Task Processor - Backward compatibility wrapper.

This file maintains backward compatibility by re-exporting the main functions
from the refactored task_processor package.
"""

# Re-export everything from the refactored package
from task_processor.task_processor import TaskProcessor
from task_processor.message_utils import _stringify_content
from task_processor.progress_handler import ProgressHandler

# These functions may not exist in the new structure, so we'll define stubs
def get_task_processor():
    """Backward compatibility stub."""
    return TaskProcessor()

def process_queue_message(*args, **kwargs):
    """Backward compatibility stub."""
    raise NotImplementedError("Use TaskProcessor.process_task() instead")

__all__ = [
    'TaskProcessor',
    'get_task_processor',
    'process_queue_message',
    '_stringify_content',
    'ProgressHandler',
]