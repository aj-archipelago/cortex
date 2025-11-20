"""
Core Coding Tool for Cortex-AutoGen2
"""

import os
import sys
import subprocess
import tempfile
import pandas
from contextlib import redirect_stdout, redirect_stderr
from io import StringIO
import traceback
from typing import Dict, Any
import json
from autogen_core import CancellationToken
from autogen_core.code_executor import with_requirements, CodeBlock
from autogen_ext.code_executors.local import LocalCommandLineCodeExecutor


@with_requirements(python_packages=["pandas"], global_imports=["pandas"])
def load_data(filename=None) -> pandas.DataFrame:
    """Load some sample data or from a CSV file.

    Args:
        filename: Optional CSV file to load. If None, returns sample data.

    Returns:
        pandas.DataFrame: A DataFrame with data
    """
    if filename:
        return pandas.read_csv(filename)
    else:
        # Return sample data
        data = {
            "name": ["John", "Anna", "Peter", "Linda"],
            "location": ["New York", "Paris", "Berlin", "London"],
            "age": [24, 13, 53, 33],
        }
        return pandas.DataFrame(data)


async def execute_python_code(code: str, work_dir: str | None = None) -> str:
    """
    Execute Python code using LocalCommandLineCodeExecutor with available functions.

    This tool provides access to pre-defined functions like load_data() that can be imported
    in the executed code using: from functions import load_data

    Args:
        code: A string containing the Python code to be executed.
        work_dir: Optional working directory for code execution. If None, uses a temporary directory.

    Returns:
        A string containing the execution results.
    """
    # Use provided work_dir or create temporary directory for this execution
    if work_dir:
        # Use the provided work directory
        executor = LocalCommandLineCodeExecutor(
            work_dir=work_dir,
            functions=[load_data]
        )

        # Execute the code
        result = await executor.execute_code_blocks(
            code_blocks=[CodeBlock(language="python", code=code)],
            cancellation_token=CancellationToken(),
        )

        if result.exit_code == 0:
            # Extract any "Ready for upload" messages from the output and add the work directory
            ready_messages = []
            for line in result.output.split('\n'):
                if line.strip().startswith('📁 Ready for upload:'):
                    ready_messages.append(line.strip())

            if not ready_messages:
                ready_messages.append(f"📁 Ready for upload: {work_dir or '/tmp/coding'}")

            response = '\n'.join(ready_messages) + '\nCODE EXECUTION SUCCESSFUL - Files created.'
            return response
        else:
            return f"CODE EXECUTION FAILED with exit code {result.exit_code}.\nOutput: {result.output}"
    else:
        # Create executor with temporary directory for isolation
        with tempfile.TemporaryDirectory() as temp_dir:
            executor = LocalCommandLineCodeExecutor(
                work_dir=temp_dir,
                functions=[load_data]
            )

            # Execute the code
            result = await executor.execute_code_blocks(
                code_blocks=[CodeBlock(language="python", code=code)],
                cancellation_token=CancellationToken(),
            )

            if result.exit_code == 0:
                return f"📁 Ready for upload: {temp_dir}\nCODE EXECUTION SUCCESSFUL - Files created.\nOutput: {result.output}"
            else:
                return f"CODE EXECUTION FAILED with exit code {result.exit_code}.\nOutput: {result.output}"


# Legacy function for backward compatibility
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

