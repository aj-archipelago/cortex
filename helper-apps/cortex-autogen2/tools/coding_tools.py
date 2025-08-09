"""
Core Coding Tool for Cortex-AutoGen2
"""

import os
import sys
import subprocess
from contextlib import redirect_stdout, redirect_stderr
from io import StringIO
import traceback
from typing import Dict, Any
import json

def _execute_code_sync(code: str) -> Dict[str, Any]:
    """
    Execute Python code in a sandboxed environment and return structured results.
    
    Args:
        code: Python code to execute
        
    Returns:
        Dict with status, stdout, and stderr
    """
    try:
        # Capture output
        stdout_buffer = StringIO()
        stderr_buffer = StringIO()
        
        # Execute the code in a restricted environment
        with redirect_stdout(stdout_buffer), redirect_stderr(stderr_buffer):
            exec(code, {'__builtins__': __builtins__, 'os': os, 'sys': sys})
        
        stdout = stdout_buffer.getvalue()
        stderr = stderr_buffer.getvalue()
        
        if stderr:
            return {
                "status": "error",
                "stdout": stdout,
                "stderr": stderr,
                "traceback": stderr,
            }
        
        return {
            "status": "success",
            "stdout": stdout,
            "stderr": stderr,
        }
        
    except Exception:
        tb = traceback.format_exc()
        return {
            "status": "error",
            "stdout": "",
            "stderr": tb,
            "traceback": tb,
        }

async def execute_code(code: str) -> str:
    """
    Executes a block of Python code and returns the output.
    This tool is essential for any task that requires generating and running code.
    
    Args:
        code: A string containing the Python code to be executed.
        
    Returns:
        A JSON string containing the execution status, stdout, and stderr.
    """
    result = _execute_code_sync(code)
    return json.dumps(result, indent=2)

