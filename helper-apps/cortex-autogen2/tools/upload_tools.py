"""
Generic upload and file management tools for the Cortex AutoGen2 system.
These tools are shared across multiple agents.
"""

import os
import logging
from typing import List, Dict, Any, Optional, Union

# =========================================================================
# Helper functions (copied from agents.util.helpers to avoid circular imports)
# =========================================================================

import json



# =========================================================================
# Tool definitions
# =========================================================================

from autogen_core.tools import FunctionTool

# Unified upload tool (handles single files and multiple files)
def upload_files_unified(file_paths: Union[str, List[str]], work_dir: Optional[str] = None) -> str:
    """
    Unified file upload function - handles single files or multiple files.

    Args:
        file_paths: Single file path (str) or list of file paths
        work_dir: Optional working directory for resolving relative paths

    Returns:
        JSON string with upload results
    """
    from tools.azure_blob_tools import upload_files
    result = upload_files(file_paths, work_dir)
    return json.dumps(result)

# Create unified upload tool
upload_tool = FunctionTool(
    upload_files_unified,
    description="Upload files to Azure Blob Storage. Accepts single file path (str) or list of file paths (List[str]). Returns JSON with upload results including download URLs. Use this for all file uploads."
)

# =========================================================================
# Tool exports
# =========================================================================

__all__ = [
    'upload_tool',
]
