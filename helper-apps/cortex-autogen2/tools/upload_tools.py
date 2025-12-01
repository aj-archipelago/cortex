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
# URL Validation (integrated into upload process)
# =========================================================================

def validate_uploaded_urls(uploads: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Validate that uploaded URLs are accessible.

    Args:
        uploads: List of upload result dictionaries with 'download_url' keys

    Returns:
        Dict with validated uploads, failed validations, and summary
    """
    from tools.url_validation_tools import validate_url_accessibility

    validated = []
    failed = []

    for upload in uploads:
        url = upload.get('download_url')
        if not url:
            failed.append({
                "file": upload.get('local_filename', 'unknown'),
                "error": "No download_url in upload result"
            })
            continue

        # Validate URL accessibility
        validation_result = validate_url_accessibility(url, timeout_seconds=5)

        if validation_result.get('accessible', False):
            validated.append(upload)
            logging.info(f"✅ URL validated: {upload.get('local_filename')}")
        else:
            failed.append({
                "file": upload.get('local_filename', 'unknown'),
                "url": url,
                "error": validation_result.get('error', 'Unknown validation error'),
                "status_code": validation_result.get('status_code')
            })
            logging.error(f"❌ URL validation failed: {upload.get('local_filename')} - {validation_result.get('error')}")

    return {
        "validated_uploads": validated,
        "failed_validations": failed,
        "total_validated": len(validated),
        "total_failed": len(failed)
    }

# =========================================================================
# Tool definitions
# =========================================================================

from autogen_core.tools import FunctionTool

# Unified upload tool (handles single files and multiple files)
def upload_files_unified(file_paths: Union[str, List[str]], work_dir: Optional[str] = None) -> str:
    """
    Unified file upload function - handles single files or multiple files.
    Includes URL validation to ensure all uploaded files are accessible.

    Args:
        file_paths: Single file path (str) or list of file paths
        work_dir: Optional working directory for resolving relative paths

    Returns:
        JSON string with upload results (only validated, accessible URLs)
    """
    from tools.azure_blob_tools import upload_files

    # Upload files
    result = upload_files(file_paths, work_dir)

    # Validate URLs are accessible
    if result.get('success', False) and 'uploads' in result:
        validation_result = validate_uploaded_urls(result['uploads'])

        # Update result with only validated uploads
        result['validated_uploads'] = validation_result['validated_uploads']
        result['failed_validations'] = validation_result['failed_validations']
        result['total_validated'] = validation_result['total_validated']
        result['total_failed'] = validation_result['total_failed']

        # Replace uploads array with only validated ones
        result['uploads'] = validation_result['validated_uploads']

        # Update success status based on validation
        if validation_result['total_failed'] > 0:
            result['validation_warnings'] = f"{validation_result['total_failed']} URLs failed validation and were excluded"

    return json.dumps(result)

# Create unified upload tool (static, for backward compatibility)
upload_tool = FunctionTool(
    upload_files_unified,
    description="Upload files to Azure Blob Storage. Accepts single file path (str) or list of file paths (List[str]). Returns JSON with upload results including download URLs. Use this for all file uploads."
)

# Helper to create FunctionTool with work_dir bound
def get_upload_tool(work_dir: Optional[str] = None) -> FunctionTool:
    """
    Create a FunctionTool for file uploads with work_dir bound.
    
    Args:
        work_dir: Working directory for resolving relative file paths
        
    Returns:
        FunctionTool configured for the specified work directory
    """
    def upload_files_bound(file_paths: Union[str, List[str]]) -> str:
        """Upload files with work_dir pre-bound."""
        return upload_files_unified(file_paths, work_dir)
    
    return FunctionTool(
        upload_files_bound,
        description="Upload files to Azure Blob Storage. Accepts single file path (str) or list of file paths (List[str]). Returns JSON with upload results including download URLs. Use this for all file uploads. Relative paths are resolved relative to the work directory."
    )

# =========================================================================
# Tool exports
# =========================================================================

__all__ = [
    'upload_tool',
    'get_upload_tool',
]
