"""
Core Coding Tool for Cortex-AutoGen2
"""
from pathlib import Path
from autogen_core import CancellationToken
from autogen_core.code_executor import CodeBlock
from autogen_ext.code_executors.local import LocalCommandLineCodeExecutor


async def execute_code(code: str, work_dir: str | None = None, language: str = "python") -> str:
    """
    Execute Python or bash code using LocalCommandLineCodeExecutor.

    Args:
        code: A string containing the code to be executed.
        work_dir: Working directory for code execution.
        language: Language of the code - "python" or "bash".

    Returns:
        A string containing the execution results.
    """
    # Create executor with work directory
    executor = LocalCommandLineCodeExecutor(work_dir=Path(work_dir) if work_dir else Path("/tmp/coding"))

    # Log code execution
    import logging
    logger = logging.getLogger(__name__)
    logger.info(f"🐍 EXECUTING CODE ({language}):\n{code}")

    # Execute the code
    result = await executor.execute_code_blocks(
        code_blocks=[CodeBlock(language=language, code=code)],
        cancellation_token=CancellationToken(),
    )

    if result.exit_code == 0:
        return f"CODE EXECUTION SUCCESSFUL ({language}).\nOutput:\n{result.output}"
    else:
        return f"CODE EXECUTION FAILED ({language}) with exit code {result.exit_code}.\nOutput:\n{result.output}"


# Keep backward compatibility alias
async def execute_python_code(code: str, work_dir: str | None = None) -> str:
    """Legacy alias for execute_code with language='python'."""
    return await execute_code(code, work_dir, language="python")


# Helper to create FunctionTool with work_dir bound
def get_code_execution_tool(work_dir: str):
    """
    Create a FunctionTool for code execution with work_dir bound.
    
    Args:
        work_dir: Working directory for code execution
        
    Returns:
        FunctionTool configured for the specified work directory
    """
    from autogen_core.tools import FunctionTool
    
    async def execute_code_bound(code: str) -> str:
        return await execute_python_code(code, work_dir)
    
    return FunctionTool(
        execute_code_bound,
        description="Execute Python code using LocalCommandLineCodeExecutor. Write your complete Python script and it will be executed in the work directory."
    )

