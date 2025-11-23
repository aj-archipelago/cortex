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
