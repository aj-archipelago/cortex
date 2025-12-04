"""
Generic upload and file management tools for the Cortex AutoGen2 system.
These tools are shared across multiple agents.
"""

import os
import time
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

        # Retry validation with delay to allow SAS URL propagation
        # Wait 2 seconds before first attempt, then retry up to 3 times with exponential backoff
        max_retries = 3
        retry_delays = [2, 4, 8]  # Exponential backoff: 2s, 4s, 8s
        validation_result = None
        
        for attempt in range(max_retries + 1):
            if attempt > 0:
                # Wait before retry (exponential backoff)
                delay = retry_delays[attempt - 1]
                logging.info(f"⏳ Retrying URL validation for {upload.get('local_filename')} after {delay}s delay (attempt {attempt + 1}/{max_retries + 1})")
                time.sleep(delay)
            elif attempt == 0:
                # Wait 2 seconds before first validation to allow SAS URL propagation
                logging.info(f"⏳ Waiting 2s for SAS URL propagation before validating {upload.get('local_filename')}")
                time.sleep(2)
            
            # Validate URL accessibility
            validation_result = validate_url_accessibility(url, timeout_seconds=5)
            
            if validation_result.get('accessible', False):
                validated.append(upload)
                logging.info(f"✅ URL validated: {upload.get('local_filename')} (attempt {attempt + 1})")
                break
        
        # If all retries failed
        if not validation_result or not validation_result.get('accessible', False):
            error_msg = validation_result.get('error', 'Unknown validation error') if validation_result else 'Validation failed after all retries'
            status_code = validation_result.get('status_code') if validation_result else None
            
            # CRITICAL: 403 errors indicate broken SAS tokens - fail immediately, no retries
            if status_code == 403 or "403" in str(error_msg) or "AuthenticationFailed" in str(error_msg):
                logging.error(f"❌ CRITICAL: SAS URL returned 403 Forbidden for {upload.get('local_filename')} - SAS token is invalid/broken")
                logging.error(f"   Blob name: {upload.get('blob_name', 'unknown')}")
                logging.error(f"   This indicates a fundamental issue with SAS token generation - upload should have failed earlier")
                # Raise exception to fail the entire upload - 403s are not recoverable
                raise ValueError(f"CRITICAL: SAS URL validation failed with 403 Forbidden for {upload.get('local_filename')}. This indicates the SAS token is invalid. Upload should not have succeeded. Blob: {upload.get('blob_name', 'unknown')}")
            
            failed.append({
                "file": upload.get('local_filename', 'unknown'),
                "url": url,
                "error": error_msg,
                "status_code": status_code
            })
            logging.error(f"❌ URL validation failed after {max_retries + 1} attempts: {upload.get('local_filename')} - {error_msg}")

    # CRITICAL: If any upload failed validation, fail the entire operation
    # 403 errors should have been caught above and raised, but check for other failures too
    if failed:
        failed_files = [f.get('file', 'unknown') for f in failed]
        failed_errors = [f.get('error', 'unknown') for f in failed]
        raise ValueError(f"Upload validation failed for {len(failed)} file(s): {failed_files}. Errors: {failed_errors}. All files must be accessible for upload to succeed.")
    
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

    # Validate URLs are accessible - this will raise ValueError if any 403 errors are detected
    if result.get('success', False) and 'uploads' in result:
        try:
            validation_result = validate_uploaded_urls(result['uploads'])
            
            # Update result with only validated uploads
            result['validated_uploads'] = validation_result['validated_uploads']
            result['failed_validations'] = validation_result['failed_validations']
            result['total_validated'] = validation_result['total_validated']
            result['total_failed'] = validation_result['total_failed']

            # Replace uploads array with only validated ones
            result['uploads'] = validation_result['validated_uploads']
            
            # CRITICAL: If validation failed, mark upload as failed
            if validation_result['total_failed'] > 0:
                result['success'] = False
                result['error'] = f"Upload validation failed: {validation_result['total_failed']} file(s) returned inaccessible URLs"
        except ValueError as e:
            # 403 errors or other critical validation failures - fail the entire upload
            result['success'] = False
            result['error'] = str(e)
            result['uploads'] = []
            result['validated_uploads'] = []
            result['failed_validations'] = result.get('uploads', [])
            result['total_validated'] = 0
            result['total_failed'] = len(result.get('uploads', []))

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
